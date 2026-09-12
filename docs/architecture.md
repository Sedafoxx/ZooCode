# ZooCode — Architecture

ZooCode is a **homegrown agent harness**: a layered LLM agent runtime where each
layer may only depend on the layers below it. Nothing is imported upward, no
layer knows about the CLI, and the CLI contains no agent logic.

```
L4  bin/zoocode.ts      CLI adapter        argv parsing · rendering · exit codes
    │
L3  lib/subagent.ts     parallel runner    runParallel · worker pool · tool scoping
    │
L2  lib/harness.ts      agentic loop       runAgent · events · termination
    │
L1  lib/llm.ts          the LLM seam       createDeepSeekClient · createMockLlmClient
    lib/tools.ts        tool registry      createCoreTools · executeTool · getTool
    lib/policy.ts       execution policy   evaluateCommand · modes · deny patterns
    lib/context-budget.ts context budget   applyContextBudget · groupMessages · stats
    │
L0  lib/types.ts        THE CONTRACT       ChatMessage · ToolDef · AgentEvent · …
    lib/config.ts       configuration      loadConfig · env > overrides
```

Supporting (side) modules that are orthogonal to the loop:
[`lib/context-budget.ts`](../lib/context-budget.ts) (bounded outbound context —
see [§5b](#5b-context-budgeting-l2-helper)),
[`lib/context.ts`](../lib/context.ts) (persistent `.zoo/state.json` memory),
[`lib/usage.ts`](../lib/usage.ts) (append-only token ledger + estimated cost),
[`lib/doctor.ts`](../lib/doctor.ts) (toolchain probe),
[`lib/files.ts`](../lib/files.ts) (project summary), [`lib/search.ts`](../lib/search.ts)
(cross-project regex search), [`lib/logger.ts`](../lib/logger.ts) (rendering only),
and [`lib/improve.ts`](../lib/improve.ts) (the guarded self-improvement loop —
see [§7c](#7c-the-self-improvement-loop-s3)).

## 1. The contract (L0)

[`lib/types.ts`](../lib/types.ts) is append-only and is imported verbatim by every
other layer. The load-bearing pieces:

| Name | Role |
| --- | --- |
| `LlmClient` | The **seam**: `chat(req: LlmRequest): Promise<LlmResponse>`. The harness never knows whether a real HTTP client or a scripted mock sits behind it. |
| `ChatMessage` | The transcript unit (`role`, `content`, optional `toolCalls` / `toolCallId` / `name`). |
| `ToolDef` | `{ name, description, parameters, handler }` — the only shape the registry and the model care about. |
| `ToolContext` | `{ cwd, signal? }`. Handlers resolve relative paths against `ctx.cwd`, never `process.cwd()`. |
| `AgentEvent` | The typed observation stream: `llm_request`, `llm_response`, `tool_call`, `tool_result`, `context_pruned`, `done`, `error`. |
| `RunAgentOptions` / `RunAgentResult` | The loop's input/output. `RunAgentOptions.model?` is an explicit override; [`resolveModel`](../lib/harness.ts) falls back to `DEEPSEEK_MODEL` → the shared `DEFAULT_MODEL` (`deepseek-chat`) from [`lib/config.ts`](../lib/config.ts). |
| `SubTask` | `{ id, prompt, system?, tools? }` — the unit fanned out by L3. |

Two conventions hold everywhere:

1. **Result objects, not exceptions.** Fallible entry points return
   `{ ok: true, data }` or `{ ok: false, error }` instead of throwing
   (`loadConfig`, `runDoctor`, `collectContext`, `searchProjects`, `runAgent`,
   `runParallel`).
2. **Never mutate the caller.** `runAgent` and `runParallel` copy their inputs.

## 2. Configuration (L0)

[`loadConfig(overrides?)`](../lib/config.ts:76) resolves config with precedence
**defaults → `process.env` → overrides** and returns a discriminated result:

```
DEEPSEEK_API_KEY   (required — absence → { ok: false, error })
DEEPSEEK_BASE_URL  → https://api.deepseek.com
DEEPSEEK_MODEL     → deepseek-chat
ZOO_MAX_STEPS      → 25
ZOO_CONCURRENCY    → 3
ZOO_TEMPERATURE    → 0.2
ZOO_CONTEXT_BUDGET_TOKENS → 48000    (estimated-token ceiling for one request)
ZOO_CONTEXT_KEEP_GROUPS   → 6        (most-recent message groups kept verbatim)
```

Counters are floored and must be `>= 1`; temperature must be `>= 0`;
`ZOO_CONTEXT_KEEP_GROUPS` may be `0` (keep nothing extra — the final group is
still always protected); blank strings are treated as absent. It never throws.

## 3. The LLM seam (L1)

[`createDeepSeekClient`](../lib/llm.ts:278) speaks OpenAI-compatible
`POST {baseUrl}/chat/completions` over Node's global `fetch`. It maps
`ChatMessage[]`→wire messages and `ToolDef[]`→function tools, parses the reply
back into an `LlmResponse`, and retries only what is retryable (HTTP 429/5xx,
timeouts, network faults) with exponential backoff capped at 2s. Non-retryable
failures **throw** — and the loop converts that throw into `{ ok: false }`.

[`createMockLlmClient`](../lib/llm.ts:331) implements the same interface from
either a function `(req) => LlmResponse` or an array of responses (the last one
repeats once the script is exhausted). This is what makes `--mock` — and the
harness test suite — possible with no network.

## 4. Tools (L1)

[`createCoreTools()`](../lib/tools.ts:435) returns the eight built-ins:
`read_file`, `write_file`, `list_files`, `search_files`, `run_command`,
`zoo_doctor`, `zoo_notes`, `finish`.

[`executeTool()`](../lib/tools.ts) is the single audited entry point and
**never throws**: an unknown tool, a handler throw, or a malformed handler
return all become `{ ok: false, error, content }`. `content` is always a string
suitable to send back to the model.

[`createCoreTools()`](../lib/tools.ts) accepts
`{ allowExec?: boolean; policy?: ExecPolicy }`. `allowExec` defaults to `true`;
with `allowExec: false` (the CLI's historical `--no-exec` wiring), `run_command`
refuses to spawn anything and returns
`Command execution is disabled (allowExec=false)`.

`policy` defaults to `createExecPolicy({ mode: 'allow' })` — the historical
behavior, i.e. the destructive-pattern denylist only. That default is what keeps
`createCoreTools()` bit-for-bit compatible with every existing caller and test;
the stricter default lives at the CLI.

`run_command` refuses a short documented denylist — POSIX recursive-force root
deletes (`rm -rf /`, `rm -rf /*`, `rm -fr /`, `rm -r -f /`), `mkfs`,
`format <drive>`, `dd if=`, fork bombs, and the Windows/PowerShell forms
(`Remove-Item -Recurse -Force`, `rmdir /s`, `del /f /s /q`, `shutdown`,
`diskpart`). It is a **safety net**, explicitly **not** a sandbox: a determined
caller can evade any string denylist.

`finish` is special only to L2: it is a no-op handler that terminates the loop.

### 4b. Execution policy (L1)

[`lib/policy.ts`](../lib/policy.ts) is the approval layer in front of
`run_command`. It has **zero imports** — no Node built-ins, no dependencies — so
it is testable in isolation and can never reach the shell itself.

`evaluateCommand(command, policy, ctx)` returns a `PolicyDecision`
(`allowed`, `mode`, machine-readable `reason`, human `detail`) and **never
throws or rejects**. Check order:

1. **Deny patterns — every mode, including `allow`.** `defaultDenyPatterns()`
   holds the labels that used to live in `lib/tools.ts`, verbatim, so the
   rendered refusal (`Command refused by policy: matched rm -rf /`) is unchanged.
2. **Mode.**

| Mode | Decision |
| --- | --- |
| `deny` | `denied-mode` for every command. |
| `allowlist` | `denied-not-allowlisted` unless the executable of **every** segment is allowlisted. |
| `ask` | Consults `policy.approve`; absent → `denied-no-approver` (fail closed), throwing/`false` → `denied-by-approver`. |
| `allow` | `allowed`. |

Segmentation (`splitSegments`) splits a line on `&&`, `||`, `;`, `|`, `&` and
newlines, respecting quotes and leaving redirections (`2>&1`, `&>`) in place: a
chain is only as safe as its weakest link. Executable extraction
(`executablesOf`) takes the first token of each segment, skips `NAME=value`
assignments, resolves quotes/basenames/`.exe`/`.cmd`, and adds the wrapped
package of `npx` / `pnpm dlx` / `yarn dlx`. Anything it cannot confidently parse
(an unmatched quote) is refused rather than guessed at.

`execPolicyFromEnv()` reads `ZOO_EXEC_POLICY` and falls back to `'allow'` for
unknown/empty/unset values — the backward-compatible default; the CLI layers its
stricter `allowlist` default on top. `describePolicy()` renders the one-line
summary used by `help` and by the `agent` / `run` startup line.

## 5. The agentic loop (L2)

[`runAgent(options)`](../lib/harness.ts:99) is the single orchestration primitive.

**Per step:**

1. emit `llm_request`; call `llm.chat(request)`; emit `llm_response`
2. append the reconstructed assistant message (`content` + `toolCalls`)
3. **no tool calls** → emit `done`, succeed with the transcript's last non-empty
   assistant text (`finalText`)
4. **tool calls** → for each: emit `tool_call`, `executeTool`, emit `tool_result`,
   append a `tool` message carrying the matching `toolCallId`
5. a `finish` call stops **immediately** and uses that tool result's content as
   `final`, even if further calls were queued

**Termination semantics** — the loop returns `ok: true` when (a) the model
answers without tools, or (b) `finish` is called. It returns `ok: false` with an
`error` when the step budget is exhausted
(`Max steps (N) reached without completion`), the client throws, the run is
aborted, or any unexpected exception escapes. The entire body runs inside a
catch, and `finalText` ignores malformed transcript entries, so `runAgent`
returns `{ ok: false }` for **all** failures — including a malformed `messages`
array — and does not throw. A caller never needs a `try/catch` around it.

Other invariants: the caller's `messages` array is copied (never mutated); a
throwing `onEvent` observer is swallowed so it cannot break the run; the loop
checks `signal.aborted` before each step and each tool call.

Immediately before every `llm.chat`, the loop passes the transcript through
`applyContextBudget` (§5b) to bound the **outbound** request. Only the request is
pruned: `RunAgentResult.messages` remains the full history, and when a step
actually prunes the loop emits `context_pruned` and records the stats as
`RunAgentResult.context` (the last applied stats, or absent when nothing was
pruned). With no `contextBudget` option the shared `DEFAULT_CONTEXT_BUDGET`
applies, so every run is bounded by default.

## 5b. Context budgeting (L2 helper)

[`lib/context-budget.ts`](../lib/context-budget.ts) is pure, deterministic and
never throws. It exists because the loop re-sends the whole transcript every
step — a measured 52-step run re-sent ~1.7M prompt tokens — so the transcript
handed to the model must be bounded.

**The grouping invariant.** DeepSeek is OpenAI-compatible: an assistant message
carrying `toolCalls` makes the request invalid unless the messages *immediately
following it* provide a `tool` result for **every** `toolCallId`, with no other
message type interleaved. Pruning therefore operates on whole **groups**, never
on individual messages:

- a **group** = an `assistant` message with `toolCalls` + ALL the `tool` messages
  that immediately follow it;
- every other message is its own single-message group.

Two operations are legal, and only these two:

| Operation | Effect | Why it is safe |
| --- | --- | --- |
| **Elide** a tool result's `content` | The message, its `toolCallId`, its `name` and its position are untouched; only the text is replaced by a short marker naming the tool and a recovering argument hint. | The call/result pairing is byte-for-byte intact. |
| **Drop** a whole group | The assistant `toolCalls` message and ALL of its `tool` results are removed together. | A call is never separated from its results, and no result outlives its call. |

A subset of a group is never dropped, and groups are never reordered.

**The two passes** (exact order):

1. estimate tokens; at or under budget → return the input **unchanged**
   (`pruned: false`);
2. group the messages and size each group;
3. mark **protected** groups — any group containing a `system` message, the group
   of the FIRST `user` message (the task), the last `keepRecentGroups` groups, and
   always the final group. Protected groups are never elided and never dropped;
4. **pass 1 — elide** (oldest unprotected group first): replace each `tool`
   content longer than `minElideChars` with a marker, re-estimate after every
   elision and stop the moment the estimate fits;
5. **pass 2 — drop** (only if still over budget): remove whole unprotected
   groups, oldest first, again stopping as soon as it fits;
6. return a NEW array — unmodified messages are reused by reference, modified
   ones are clones — plus `ContextStats`.

`estimateTokens` is `ceil(chars / 4) + 1`, documented in the source as an
**estimate** and never as a tokenization. Idempotence is structural: already
elided content is recognised by its marker prefix and skipped, so running the
pruner on its own output cannot double-elide.

The defaults live in [`lib/config.ts`](../lib/config.ts)
(`DEFAULT_CONTEXT_BUDGET_TOKENS` = 48000, `DEFAULT_CONTEXT_KEEP_GROUPS` = 6) and
are surfaced as `DEFAULT_CONTEXT_BUDGET`; the CLI maps
`--context-budget <tokens>` / `--keep-recent <n>` — or the two env vars — onto
`RunAgentOptions.contextBudget`. `runParallel` forwards the same option to every
sub-task. The CLI writes one `[context] pruned: …` line to **stderr** and exposes
the stats as `context` in `--json`.

## 6. The concurrency model (L3)

[`runParallel(tasks, options)`](../lib/subagent.ts:153) fans `SubTask`s out over
`runAgent` behind a **classic worker pool**:

- `concurrency` is normalized: `undefined`/`NaN` → `DEFAULT_CONCURRENCY` (3),
  anything below 1 → 1, otherwise floored. Pool width is
  `min(concurrency, tasks.length)`.
- Each worker pulls the next index off a **single shared cursor**. Because the
  index is claimed synchronously before the first `await`, at most
  `concurrency` tasks are ever in flight.
- **Isolation:** every task gets its own transcript
  ([`createMessages`](../lib/harness.ts:63)) and its own scoped tool list
  ([`toolsForTask`](../lib/subagent.ts:93): omitted/empty `tools` → the full pool,
  otherwise only the named tools, in request order, unknown names dropped).
- **Ordering:** results come back in input order regardless of completion order.
- **Failure isolation:** a task that throws becomes `{ ok: false, error }` and the
  rest of the batch still runs. `ok` is true only if **every** task succeeded.
- **Abort:** with a signal, workers stop claiming new tasks and unclaimed slots
  are filled with an `Aborted` failure.
- Empty input resolves immediately without touching the LLM.

## 7. The CLI adapter (L4)

[`bin/zoocode.ts`](../bin/zoocode.ts) is the only place that knows about argv,
stdout/stderr, and exit codes:

- A hand-rolled parser handles `--flag`, `--flag value`, and `--flag=value`. Only
  an explicit per-command `valueFlags` list consumes the next token, which keeps
  `agent "hi" --mock` unambiguous.
- `tools`, `doctor`, `analyze`, `search` reuse L0–L1 modules directly.
- `commit` / `scaffold` spawn the pre-existing scripts with inherited stdio.
- `--mock` swaps in a scripted client so **every** command works without an API
  key. Without `--mock`, a config failure prints the error plus a hint to set
  `DEEPSEEK_API_KEY` and exits 1.
- `--exec-policy <deny|allowlist|ask|allow>` (on `agent`, `chat`, `run`) builds a
  `lib/policy.ts` policy and passes it as `createCoreTools({ policy })`.
  `--allow-exec` is shorthand for `allow`, `--no-exec` for `deny`. Precedence is
  explicit flag > `ZOO_EXEC_POLICY` > the CLI default `allowlist`; an unknown env
  value is reported on stderr and treated as unset, so a typo cannot loosen
  execution.
- `--exec-policy ask` is only satisfiable in `chat`, where the approver reuses
  the REPL's readline queue to show the command and cwd (empty input/EOF = no).
  `agent` / `run` reject `ask` up front with the fix to use, rather than running
  without an approver.
- The active policy is never invisible: `zoocode help` prints the CLI default and
  `agent` / `run` write `[exec-policy] …` to **stderr** so `--json` stays clean.
- `--events` renders `AgentEvent`s to **stderr**, keeping `--json` payloads clean
  on stdout. `context_pruned` is rendered there too.
- `--context-budget <tokens>` / `--keep-recent <n>` (on `agent`, `chat`, `run`)
  build `RunAgentOptions.contextBudget`, falling back to
  `ZOO_CONTEXT_BUDGET_TOKENS` / `ZOO_CONTEXT_KEEP_GROUPS` and then to
  `DEFAULT_CONTEXT_BUDGET`. A step that prunes writes one `[context] pruned: …`
  line to **stderr** and `--json` carries the last applied stats as `context`.
- `chat` drives the loop over one accumulating transcript: the returned
  `result.messages` (which includes the just-finished turn) becomes the next
  turn's input.
- `agent`, `chat` and `run` wrap their `LlmClient` in a recording decorator
  (`withUsageRecording`, mirroring `scripts/live-test.ts`) so the token usage
  the harness event stream drops is accumulated and written once per run.
- `usage [--json] [--days N] [--model <name>]` is a **read-only** view over the
  ledger: a compact overall / per-model / per-day table, or the raw
  `UsageSummary` with `--json`. It never calls `recordUsage`.
- `main()` is async with a top-level `await` inside `try/catch`; failures set
  `process.exitCode = 1` so buffered stdout is never truncated.

## 7b. Usage ledger (support)

[`lib/usage.ts`](../lib/usage.ts) persists the token usage that
[`lib/llm.ts`](../lib/llm.ts) already parses but the event stream discards.

- **Format.** Append-only JSONL at `<root>/.zoo/usage.jsonl`, one `UsageEntry`
 per line. Appends use `appendFileSync`; because the file is only ever
 appended to (never rewritten in place), an interrupted write can at worst
 truncate the *final* line — which `readUsage` skips and counts — so the
 atomic write-temp-then-rename dance [`lib/context.ts`](../lib/context.ts)
 needs for a single JSON document is unnecessary here.
- **Wiring.** The CLI records exactly one aggregate entry per `agent`, `chat`
 (session) or `run` (parallel batch). Recording is skipped when the run
 reports **zero total tokens** (every `--mock` run) or when **`ZOO_NO_USAGE=1`**
 is set — both documented in [`bin/zoocode.ts`](../bin/zoocode.ts).
- **Root resolution.** Mirrors context: explicit `root` > `ZOO_USAGE_DIR` > repo
 root via `import.meta.url`, so tests redirect into a temp dir.
- **Robustness.** A missing file reads as `[]`; corrupt lines are skipped and
 tallied in `skippedLines`; every entry point returns `{ ok, data?, error? }`
 (with `skippedLines` on reads) and **never throws** — including when `.zoo`
 is a file rather than a directory.
- **Pricing honesty.** `DEFAULT_PRICING` is a small, clearly-commented *estimate*
 (each seed row states its assumption and that it may be stale). Prices are
 overridable per model via `<root>/.zoo/pricing.json`. `estimateCostUsd` is
 labelled an estimate everywhere; a model with no price reports cost `0` **and**
 appears in `UsageSummary.unpricedModels`, so a missing price is never mistaken
 for "free".
- **Read-only view.** `zoocode usage` prints the window, an explicit
 "estimated, not billing" note, and lists unpriced models.

## 7c. The self-improvement loop (S3)

[`lib/improve.ts`](../lib/improve.ts) is the one module that lets the harness
modify **its own source repository**. It is deliberately the most constrained
module in the project: not a thin wrapper around `runAgent`, but a set of rails
that must all hold for a run to report success.

`runImprovement(options)` returns an `ImproveReport` and **never throws** — every
failure path resolves with `ok: false` plus an `error`, and the report is
populated either way. `ok` is true only when the preflight passed, the agent
finished, **and** the mandatory gate was green.

| # | Step | Rail enforced |
| --- | --- | --- |
| 1 | `isGitRepo(cwd)` + `getStatus(cwd)` (both from [`lib/git.ts`](../lib/git.ts)) | **Preflight** — not a repo, or a dirty tree, is refused before any write. `dryRun` returns here with the plan. |
| 2 | `git checkout -b zoo/improve-<timestamp>` | **Branch isolation** — the agent never works on the user's branch; a failure to create the branch aborts the run. |
| 3 | `guardTools(createCoreTools({ policy: allowlist }), root)` then `runAgent` | **Repo-scoped write guard**, **command guard**, **bounded steps** (`maxSteps`, default 25). |
| 3b | `createSteeringLlmClient(llm, { maxSteps })` wraps the client | **Step-budget steering** — appends a `user` reminder to the OUTBOUND request at 60% (nudge) and 85% (warn) of the budget; each tier at most once, at most one per step, and the request is copied so the loop's transcript is never mutated. |
| 4 | `capturePatch` (right after the agent) | **Partial-progress snapshot** — `git add -A` → `git diff --cached` → `git reset -q` captures the run's full diff (untracked files included) and leaves the tree unstaged/unchanged. |
| 5 | `collectDiff` / `verifyRepo(cwd, 'npm run verify')` | Reports the changed files + diff stat, then the **mandatory verify gate** — a red gate forces `ok: false` even after an agent success. |
| 6 | `stageAll` + `commit`, only when `commit: true` | **No unreviewed commits** — the default leaves the change on the branch, uncommitted. |
| 7 | `writeArtifacts` (always, in a `finally`) | **Partial-progress artifacts** — writes `changed.patch` + `report.json` to `<root>/.zoo/improve/<runId>/` on EVERY post-agent path, success or failure. A failed write only adds a note. |

`guardTools(tools, root)` returns a copy of the tool list in which:

- `write_file` resolves its `path` against the root, refuses anything outside it
  (lexical containment: `..` traversal and absolute escapes), and refuses
  `.env`, `.env.*`, `.git/`, `node_modules/`, `.claude/` and `.zoo/usage.jsonl`
  even when they resolve inside the root. Refusals return
  `{ ok: false, error: 'Refused: <reason>', content: <path> }` and never touch
  disk.
- `run_command` refuses a `cwd` outside the root; its policy gate is supplied by
  the caller — `allowlist` here, never `allow`.
- Every other tool is returned unchanged, so the tool count is untouched.

Containment is decided **lexically** (`path.resolve` normalizes `.`/`..` and
absolute segments); symlinks are deliberately not resolved. This is a
belt-and-braces layer on top of branch isolation, not a sandbox.

Two behavioural guards sit around the loop, because over-deliberation — not
context size — was the observed failure mode:

- `defaultImproveSystemPrompt(goal)` states that the deliverable is a **written
  change, not a plan**: no plans/analyses/summaries, no repository surveys, write
  or edit the target file **within the first three tool calls**, prefer editing an
  existing file, run the test/typecheck commands only *after* the change, and call
  `finish` as soon as the goal is met.
- `createSteeringLlmClient(inner, { maxSteps, nudgeAt, warnAt })` counts
  `chat()` calls and appends **one** `role: 'user'` reminder to the outbound
  request at 60% of the budget (nudge: "stop exploring, write now") and another
  at 85% (warn: "only N steps remaining, write immediately then `finish`"). Each
  tier fires at most once (the highest tier already injected is remembered), at
  most one message is added per step, and the wrapper is **inert** when
  `maxSteps` is missing/`<= 0`. Crucially it builds
  `{ ...req, messages: [...req.messages, reminder] }`: `applyContextBudget` hands
  the loop's own live transcript array to the request when nothing needs pruning,
  so mutating `req.messages` would corrupt the loop's history and leak into
  `RunAgentResult.messages`. `ImproveReport.steeringInjected` records the count.

After the agent stops — success **or** failure — `runImprovement` archives the
run under `<root>/.zoo/improve/<runId>/`: `changed.patch` (the full diff of the
working tree, untracked files included, captured before the gate and the opt-in
commit so it survives either) and `report.json` (the serialized `ImproveReport`,
which carries its own `artifactsDir`). The write runs in a `finally`, is wrapped
so a failure only appends a preflight note, and cannot dirty the tree:
`.zoo/improve/` is listed in the repository's `.gitignore` and the loop also
appends it to the target repo's `.git/info/exclude` — an ignore mechanism git
does not report — so `git status --porcelain` stays clean and the next run's
clean-tree preflight still starts. The tree is left **unstaged and unchanged**.

`verifyRepo(cwd, command)` **intentionally shells out** (the reason is in the
source): the gate must be the same command a human runs, not a reimplementation
that can drift. It uses a 10-minute timeout, captures the exit code plus a
~40-line tail of the combined output, and never throws.

The CLI surface (`zoocode improve "<goal>"`) adds three decisions on top: a
**real API key** is required (there is no `--mock` fallback), the exec policy is
**forced to `allowlist`** regardless of `--exec-policy` / `--allow-exec` /
`ZOO_EXEC_POLICY`, and the output states plainly whether anything was committed
and that the work otherwise sits on the branch awaiting review. `--json` prints
the whole `ImproveReport`.

Because this feature edits the repository it ships in, no automated test ever
points it at ZooCode: [`tests/improve.test.ts`](../tests/improve.test.ts) drives
`runImprovement` in temp git repos with the mock LLM and an injected gate runner.

## 8. Verification gate

```bash
npm run verify     # oxlint && tsc --noEmit && vitest run
```

`strict` + `noUnusedLocals` + `noUnusedParameters` + `verbatimModuleSyntax` +
`erasableSyntaxOnly` are all on, so the type signature of every seam is enforced
at the gate.

`vitest run` covers **292 passing tests** (293 collected across 19 files; the
1-test live-network suite in [`tests/live.test.ts`](../tests/live.test.ts) is
skipped unless an API key is present, leaving 18 files that report passes):
every lib module — including the context pruner in
[`tests/context-budget.test.ts`](../tests/context-budget.test.ts), the policy
engine in [`tests/policy.test.ts`](../tests/policy.test.ts),
and the self-improvement rails in
[`tests/improve.test.ts`](../tests/improve.test.ts) — plus the hermetic CLI smoke
tests in [`tests/cli.test.ts`](../tests/cli.test.ts), which spawn
`npx tsx bin/zoocode.ts …` with no API key in the child environment.
Those CLI tests reach the real policy path offline through the scripted mock's
`mock-run: <command>` task prefix, which turns a fake task into one genuine
`run_command` call. A sibling `mock-long: <n>` prefix issues `<n>` large
`read_file` calls, which is how the context-budget path — the stderr summary and
the `--json` `context` stats — is exercised offline. The **live** DeepSeek
network path is otherwise **not** exercised by the automated suite.

## 9. Build history

The harness was built bottom-up by layer workstreams; each layer was completed
and locked before the next one started, so no worker ever edited another's files.

| Order | Layer | Modules | Workstream |
| --- | --- | --- | --- |
| 1 | L0 contract | `lib/types.ts`, `lib/config.ts` | L0 worker — locked |
| 2 | L1 | `lib/llm.ts`, `lib/tools.ts`, `lib/logger.ts` | L1 worker — locked |
| 3 | L2 | `lib/harness.ts` | L2 worker — locked |
| 4 | L3 | `lib/subagent.ts` | L3 worker — locked |
| 5 | Support | `lib/context.ts`, `lib/files.ts`, `lib/search.ts`, `lib/doctor.ts`, `scripts/*` | support workers — locked |
| 5b | **Context management** | `lib/context-budget.ts`, `lib/harness.ts`, `lib/types.ts`, `lib/config.ts`, `lib/subagent.ts`, `bin/zoocode.ts` | **C1** |
| 6 | **L4 + wiring** | **`bin/zoocode.ts`, `package.json`, `tsconfig.json`, docs** | **F5** |
| 7 | **Hardening + integration** | `lib/types.ts`, `lib/harness.ts`, `lib/tools.ts`, `lib/subagent.ts`, `bin/zoocode.ts`, tests, docs | **F6** |
| 8 | **Execution safety** | **`lib/policy.ts`, `lib/tools.ts`, `bin/zoocode.ts`, tests, docs** | **S1** |
| 9 | **Usage & cost tracking** | **`lib/usage.ts`, `bin/zoocode.ts`, tests, docs** | **S2** |
| 10 | **Self-improvement loop** | **`lib/improve.ts`, `bin/zoocode.ts`, tests, docs** | **S3 (this workstream)** |

F5 shipped no agent logic: it imported the locked modules, wired them into the
CLI, added the `bin` entry + `zoocode`/`agent`/`doctor`/`verify` scripts, brought
`npx tsc --noEmit` to zero errors via three unused-symbol cleanups, and
documented the result. The exact workstream IDs for layers 1–5 were not exposed
to this workstream; they are recorded here by layer and by the fact that the
modules were frozen and unmodified by F5.

F6 hardened the seams without any architectural rework: `runAgent` is now
genuinely non-throwing on malformed input, `RunAgentOptions` carries a typed
`model`, the shared defaults live only in `lib/config.ts`, the `run_command`
denylist covers the `rm -rf /*` bypass plus Windows/PowerShell destructive
commands, `createCoreTools({ allowExec: false })` / `--no-exec` add an explicit
execution opt-in, and the CLI finally has automated smoke tests.

S2 added the usage ledger described in §7b: `lib/usage.ts` plus the CLI wiring
that records one aggregate entry per `agent` / `chat` / `run`, and the read-only
`zoocode usage` view.

S3 (this workstream) added [`lib/improve.ts`](../lib/improve.ts) — the
self-improvement loop — and the `zoocode improve` CLI surface. No existing module
was changed: the loop composes the already-locked L1–L3 modules, wraps the tool
list in `guardTools`, forces the `allowlist` policy, and adds the preflight,
branch-isolation, bounded-step, verify-gate and opt-in-commit rails described in
§7c. Every new test is hermetic (temp git repos + mock LLM + injected gate), so
the loop is never pointed at this repository by the suite.

C1 (context management) added [`lib/context-budget.ts`](../lib/context-budget.ts)
and wired it into `runAgent` immediately before each `llm.chat`, so the outbound
request is bounded by default while `RunAgentResult.messages` keeps the full
history. `RunAgentOptions.contextBudget`, the `context_pruned` event and
`RunAgentResult.context` were added additively to the contract; `lib/config.ts`
gained `ZOO_CONTEXT_BUDGET_TOKENS` / `ZOO_CONTEXT_KEEP_GROUPS`; and the CLI grew
`--context-budget` / `--keep-recent` plus the stderr summary and the `--json`
stats. The whole feature is offline-testable: the grouping/pairing invariant and
the two passes are unit-tested, and a scripted multi-step mock proves a later
request is smaller than the transcript returned to the caller.

S1 put a real policy layer in front of the one tool that grants
arbitrary code execution. The denylist moved out of `lib/tools.ts` into the new
[`lib/policy.ts`](../lib/policy.ts) — labels preserved verbatim — and gained four
modes (`deny` / `allowlist` / `ask` / `allow`), shell-aware command segmentation,
executable extraction, an optional interactive approver, and `ZOO_EXEC_POLICY`
support. `createCoreTools({ policy })` wires it in while the no-argument call
still behaves exactly as before (`mode: 'allow'`); the CLI defaults to the
stricter `allowlist` via `--exec-policy` / `--allow-exec` / `--no-exec`, prints
the active policy in `help` and on the `agent` / `run` startup line, and fails
closed whenever `ask` has nobody to ask.
