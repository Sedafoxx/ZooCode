# 🦁 ZooCode

A **homegrown agent harness** — an LLM agent loop, a tool registry, parallel
sub-agents, and a CLI, built from scratch on Node's standard library.

ZooCode is not a wrapper around an agent framework. Every layer below the CLI is
Zoo's own code with its own contract ([`lib/types.ts`](lib/types.ts)), and the CLI
is a thin L4 surface that wires those layers together. The only runtime
dependency is Node itself — the project ships with **zero runtime deps** and adds
no new dev deps for the harness.

## Quickstart

```bash
npm install

# Option A — environment variable (bash / zsh / Git Bash)
export DEEPSEEK_API_KEY="sk-..."

# Option A — environment variable (PowerShell)
$env:DEEPSEEK_API_KEY="sk-..."

# Option B — gitignored local file (no VS Code restart needed)
Copy-Item .env.example .env   # then put your key in .env

npx tsx bin/zoocode.ts agent "list the files in lib and summarize what each does"
```

A real environment variable always wins over `.env`. The file is read by
[`lib/dotenv.ts`](lib/dotenv.ts), and only the entrypoints call it — so
[`loadConfig()`](lib/config.ts:76) stays a pure, testable env reader.

No API key? Every agent command runs fully offline against the scripted mock:

```bash
npx tsx bin/zoocode.ts agent "say hello" --mock
```

### Verifying the live path

```bash
npm run live    # real end-to-end run: read_file x2 -> finish, reports token usage
```

Exit codes: `0` success, `1` failure, `2` no API key (no request attempted).

The vitest variant is **double opt-in** — a key *plus* `ZOO_LIVE=1` — so the
offline gate (`npm run verify`) never spends tokens:

```bash
# bash / zsh
ZOO_LIVE=1 npx vitest run tests/live.test.ts

# PowerShell
$env:ZOO_LIVE=1; npx vitest run tests/live.test.ts
```

Tests that assert "no key configured" set `ZOO_NO_DOTENV=1` so a real local
`.env` is ignored. Both flags are documented in [`lib/dotenv.ts`](lib/dotenv.ts).

### npm scripts

| Script | What it runs |
| --- | --- |
| `npm run zoocode -- <args>` | `tsx bin/zoocode.ts <args>` |
| `npm run agent -- "<task>"` | `tsx bin/zoocode.ts agent "<task>"` |
| `npm run doctor` | `tsx bin/zoocode.ts doctor` |
| `npm run verify` | `oxlint && tsc --noEmit && vitest run` — the full gate |
| `npm run live` | `tsx scripts/live-test.ts` — live end-to-end test (needs a key) |

## Architecture

Five layers, each only allowed to talk downward. The CLI is a pure adapter: it
owns argv parsing, rendering, and exit codes — never agent logic.

```
L4  CLI            bin/zoocode.ts        argv parsing · rendering · exit codes
     │
L3  Sub-agents     lib/subagent.ts       runParallel · worker pool · tool scoping
     │
L2  Harness        lib/harness.ts        runAgent · the agentic loop · events
     │
L1  LLM + Tools    lib/llm.ts            LlmClient seam (DeepSeek + mock)
                   lib/tools.ts          ToolDef registry (8 core tools)
                   lib/policy.ts         execution policy (deny patterns · modes)
     │
L0  Contract       lib/types.ts          ChatMessage · ToolDef · AgentEvent · …
                   lib/config.ts         env / override resolution
```

Supporting modules: [`lib/context.ts`](lib/context.ts) (persistent
`.zoo/state.json` memory), [`lib/usage.ts`](lib/usage.ts) (usage & cost ledger),
[`lib/doctor.ts`](lib/doctor.ts) (toolchain checks),
[`lib/files.ts`](lib/files.ts) (project summaries), [`lib/search.ts`](lib/search.ts)
(cross-project regex search), [`lib/logger.ts`](lib/logger.ts) (terminal output),
and [`lib/improve.ts`](lib/improve.ts) — the guarded self-improvement loop
([Improving itself](#improving-itself)).

See [`docs/architecture.md`](docs/architecture.md) for the contract, the loop and
termination semantics, and the concurrency model.

## CLI

```
zoocode tools [--json]
zoocode agent "<task>" [--system <text>] [--max-steps N] [--cwd <path>] [--mock] [--json] [--events] [--exec-policy <mode>] [--allow-exec] [--no-exec]
zoocode chat [--mock] [--system <text>] [--exec-policy <mode>] [--allow-exec] [--no-exec]
zoocode run <file.json | -> [--concurrency N] [--mock] [--json] [--exec-policy <mode>] [--allow-exec] [--no-exec]
zoocode doctor [--json]
zoocode analyze <dir> [--json]
zoocode search <pattern> [--ext .ts] [--max N] [--project <name>] [--json]
zoocode usage [--json] [--days N] [--model <name>]
zoocode improve "<goal>" [--max-steps N] [--verify-cmd "<cmd>"] [--commit] [--dry-run] [--no-branch] [--json]
zoocode commit [args...]
zoocode scaffold [args...]
zoocode help
```

- `tools` — prints the core tool table (`--json` for the raw array).
- `agent` — one task through the loop. `--events` streams every `AgentEvent` to
  **stderr**, so `--json` stays machine-readable on stdout.
- `chat` — interactive REPL ([`node:readline`](bin/zoocode.ts)) over **one running
  transcript**; each line extends the same history. `/exit` (or EOF) quits.
- `run` — reads a JSON array of sub-tasks from a file or stdin (`-`) and fans
  them out with a concurrency ceiling.
- `usage` — read-only summary of the recorded token ledger (see
  [Usage & cost tracking](#usage--cost-tracking)).
- `improve` — one guarded self-improvement pass over **this** repository (see
  [Improving itself](#improving-itself)). It edits this repository's own source,
  so it warns, requires a real API key, and always forces the strict `allowlist`
  exec policy.
- `--exec-policy <deny|allowlist|ask|allow>` — on `agent`, `chat`, and `run`,
  decides what `run_command` may do (see [Execution safety](#execution-safety)).
  `--allow-exec` is shorthand for `allow`; `--no-exec` is shorthand for `deny`.
  With no flag the CLI uses `ZOO_EXEC_POLICY`, else its default of `allowlist`.
  The active policy is always printed — in `zoocode help` and on the `agent` /
  `run` startup line.
- `commit` / `scaffold` — passthroughs that spawn the existing
  [`scripts/commit.ts`](scripts/commit.ts) / [`scripts/scaffold.ts`](scripts/scaffold.ts)
  with inherited stdio.

Exit codes: `agent` and `run` exit `0` on success and `1` otherwise; `doctor`
exits `0` when healthy; unknown commands exit `1`.

### Tool list

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a UTF-8 file (relative to `cwd`, truncated). |
| `write_file` | Write a UTF-8 file, creating parent directories. |
| `list_files` | List a directory, optionally recursive. |
| `search_files` | Regex-search projects → `project/file:line: text`. |
| `run_command` | Run a shell command, gated by the execution policy (see [Execution safety](#execution-safety)). |
| `zoo_doctor` | Run the environment doctor. |
| `zoo_notes` | Read/append persistent per-project notes and todos. |
| `finish` | Terminal tool: explicit "task complete" signal. |

```bash
npx tsx bin/zoocode.ts tools
```

## Execution safety

`run_command` is the one tool that hands arbitrary code execution to a model, so
it runs behind [`lib/policy.ts`](lib/policy.ts) — a dependency-free policy
engine. **Deny patterns are checked first, in every mode**; then the mode decides:

| Mode | Behaviour |
| --- | --- |
| `deny` | Refuse every command. |
| `allowlist` | Allow only when the executable of **every** segment of the line is allowlisted (`a && b`, `a \| b`, `a ; b`, newlines). |
| `ask` | Ask an approver per command; with no approver it fails **closed** (`denied-no-approver`) — never silently allows. |
| `allow` | Permit everything the deny patterns did not catch. |

A refused command comes back as
`{ ok: false, error: 'Command refused by policy: <detail>', content: <command> }`.

| Layer | Default | Control |
| --- | --- | --- |
| CLI | `allowlist` | `--exec-policy <mode>`, `--allow-exec` (= `allow`), `--no-exec` (= `deny`) |
| Environment | `allow` for unknown/empty values | `ZOO_EXEC_POLICY` |
| Library | `allow` | `createCoreTools()` — unchanged and permissive |

Precedence: explicit flag > `ZOO_EXEC_POLICY` > CLI default (`allowlist`). The
CLI is stricter than the library on purpose; an unknown `ZOO_EXEC_POLICY` value
is reported on stderr and treated as unset so a typo can never loosen execution.

`ask` needs a human. In `chat` it is wired to an interactive prompt showing the
command and the working directory (empty input or EOF means **no**); in
`agent` / `run` there is nobody to ask, so it fails closed and tells you to pass
`--exec-policy allowlist` or `--allow-exec`.

[`defaultAllowlist()`](lib/policy.ts) is intentionally tight — `node`, `npm`,
`npx`, `pnpm`, `yarn`, `tsx`, `tsc`, `vitest`, `oxlint`, `echo`, `mkdir`, `dir`,
`ls`, `cat`, `type`, `git`, `python`, `py`, `pip`, `pwsh`. Anything else is
refused; expect to extend it as legitimate workflows appear. This is a policy
layer, **not a sandbox**: interpreter arguments (`node -e "…"`), command
substitution (`$(…)`, backticks) and here-docs are not resolved.

```bash
npx tsx bin/zoocode.ts agent "run the test suite"              # CLI default: allowlist
npx tsx bin/zoocode.ts chat --exec-policy ask                  # approve every command
npx tsx bin/zoocode.ts agent "scratch that, trust me" --allow-exec
```

## Usage & cost tracking

Every real `agent` / `chat` / `run` session records one **aggregate** line to
`<repo>/.zoo/usage.jsonl` — an append-only JSONL ledger
([`lib/usage.ts`](lib/usage.ts)). It captures the run kind, model, run id, step
count, prompt/completion/total tokens, wall-clock duration, success flag, and a
short label. The ledger is **local telemetry**: it is gitignored
(`.zoo/state.json` stays tracked) and is never required for a run to succeed.

```bash
npx tsx bin/zoocode.ts usage                 # last 7 days, human table
npx tsx bin/zoocode.ts usage --days 30
npx tsx bin/zoocode.ts usage --model deepseek-chat
npx tsx bin/zoocode.ts usage --json          # the whole UsageSummary
```

`usage` is **read-only** — it never mutates the ledger. Two opt-outs keep the
ledger meaningful:

- **`ZOO_NO_USAGE=1`** — disables recording entirely (used by the hermetic CLI
 tests; also handy in CI).
- **zero total tokens** — a run whose client reports no usage (e.g. every
 `--mock` run) is not recorded, so mock runs never pollute real numbers.

**Cost is an estimate, not billing.** Token counts come from the API and are
facts; the dollar figure is computed from a *configurable* table
([`DEFAULT_PRICING`](lib/usage.ts) holds the seed values, each documented with
the assumption behind it) and may be **stale** — DeepSeek changes prices. Output
is always labelled `estimatedCostUsd`. Override any row in `.zoo/pricing.json`:

```json
{ "models": [ { "model": "deepseek-chat", "promptUsdPerMillion": 0.27, "completionUsdPerMillion": 1.10 } ] }
```

A model with **no known price reports cost `0` and is listed under
`unpricedModels`** in the summary (and called out in the CLI output) so a missing
price is never silently read as "free". For the authoritative number, see your
DeepSeek dashboard/invoice.

## Improving itself

ZooCode can improve **its own source repository**:

```bash
npx tsx bin/zoocode.ts improve "add a --version flag to the CLI"
```

This is the highest-risk feature in the project, so it is assembled from
mandatory rails ([`lib/improve.ts`](lib/improve.ts)) rather than wrapped thinly
around [`runAgent()`](lib/harness.ts:103):

| Rail | What it enforces |
| --- | --- |
| **Preflight** | The target must be a git repo with a **clean** working tree. A dirty tree is refused *before* anything is written. `--dry-run` stops here and prints the plan. |
| **Branch isolation** | Before the agent starts, the loop creates and checks out `zoo/improve-<timestamp>`, so nothing ever lands on your current branch. If the branch cannot be created, the run aborts. `--no-branch` opts out. |
| **Repo-scoped write guard** | `write_file` is wrapped ([`guardTools()`](lib/improve.ts)) so the resolved target must be inside the repo root — `..` traversal and absolute escapes are refused — and `.env`, `.env.*`, `.git/`, `node_modules/`, `.claude/` and `.zoo/usage.jsonl` are refused even inside it. A refusal returns `{ ok: false, error: 'Refused: …', content: <path> }` and never touches disk. |
| **Command guard** | `run_command` always runs under `createExecPolicy({ mode: 'allowlist' })`: `--exec-policy`, `--allow-exec` and `ZOO_EXEC_POLICY` are ignored for this command, there is no `allow` mode here, and a command whose `cwd` is outside the repo root is refused. |
| **Bounded work** | `maxSteps` (default 25, `--max-steps`) bounds the loop. Exhausting it still produces a full report. |
| **Mandatory verify gate** | After the agent stops, the gate command (`npm run verify`, override with `--verify-cmd`) runs in the repo. A **red gate forces `ok: false` even if the agent reported success** — success is never claimed without a green gate. |
| **No unreviewed commits** | `commit` defaults to `false`. `--commit` stages everything and commits with a conventional `chore(improve): <goal>` message after a green verify; otherwise the changes stay on the branch, unstaged, for human review. |

Two more rules live in the CLI: `improve` requires a **real API key** (there is no
`--mock` fallback — a fake improvement would be worse than a failure), and it
always says out loud that it edits this repository.

The loop **never throws**: every failure path returns a populated `ImproveReport`
with `ok: false` and `error`, and `--json` prints that report verbatim.

```
goal · branch · preflight { isGitRepo, clean, notes } · agent { steps, final } ·
changedFiles · diffStat · verify { command, exitCode, tail } · committed · error
```

The human output shows the branch, the preflight result, the changed files, a
diff stat, the verify command and its result (with a tail of the output when it
fails), and — prominently — that **nothing was committed and the work sits on the
branch awaiting review**.

Review it like any other branch:

```bash
git diff <the branch printed in the report>    # inspect exactly what the agent did
npm run verify                                 # confirm the gate yourself
git checkout master && git merge <the branch>  # merge only if you are happy
```

Because this feature edits the repository it lives in, the automated suite
**never** points the real loop at ZooCode:
[`tests/improve.test.ts`](tests/improve.test.ts) drives `runImprovement` inside
temp git repositories with the mock LLM and an injected gate runner, so no test
ever touches this working tree or the network.

## The verify gate

Every change must pass the combined gate:

```bash
npm run verify     # oxlint && tsc --noEmit && vitest run
```

- `oxlint` — 0 errors (one pre-existing `no-control-regex` warning in
  [`lib/doctor.ts`](lib/doctor.ts:38), which is intentional ANSI stripping).
- `tsc --noEmit` — 0 errors under `strict`, `noUnusedLocals`,
  `noUnusedParameters`, `verbatimModuleSyntax`, `erasableSyntaxOnly`.
- `vitest run` — 252 passing tests (253 collected across 18 files; the 1-test
  live-network suite in [`tests/live.test.ts`](tests/live.test.ts) is skipped
  when no API key is present, so 17 of the files report passes): every lib layer
  — including the policy engine in [`tests/policy.test.ts`](tests/policy.test.ts)
  and the self-improvement rails in
  [`tests/improve.test.ts`](tests/improve.test.ts) — plus hermetic CLI smoke tests
  ([`tests/cli.test.ts`](tests/cli.test.ts)) that spawn
  `npx tsx bin/zoocode.ts …` with no API key in the child environment and drive
  the real `run_command` policy path offline via a `--mock "mock-run: <command>"`
  task. The **live** DeepSeek path is otherwise not part of the automated suite;
  it is validated manually.

## Project layout

```
ZooCode/
├── bin/          L4 — the zoocode CLI
├── lib/          L0–L3 — types, config, llm, tools, harness, sub-agent, …
├── scripts/      standalone utilities (scaffold, analyze, search, commit, doctor)
├── tests/        vitest suites for every layer
├── docs/         architecture notes
├── .zoo/         persistent context (state.json) + local usage ledger
└── PLAN.md       build plan, layer map, and definition-of-done evidence
```
