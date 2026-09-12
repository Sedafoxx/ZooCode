# PLAN — ZooCode homegrown agent harness

The plan of record for the harness, the layer map, and the definition-of-done
evidence for the **F5 (CLI + wiring)** and **F6 (hardening + integration)**
workstreams.

## 1. Goal

Turn ZooCode from a folder of scripts into a **homegrown agent harness**: a
layered LLM agent runtime (contract → llm/tools → loop → sub-agents → CLI) that
runs on Node's standard library, is test-covered at the lib layers **and** via
end-to-end CLI smoke tests, typechecks under `strict`, and is drivable
end-to-end from a single CLI — including offline via a scripted mock.

What the automated suite does **not** cover: the **live DeepSeek API path**.
`--mock` and the scripted `LlmClient` stand-ins are what the suite drives; a real
network round-trip is validated manually. (The one live-network test in
`tests/live.test.ts` is skipped unless an API key is present, so the default
`npm test` run reports 15 files passed and 1 file skipped.)

## 2. Layer map

| Layer | Modules | Responsibility | Status |
| --- | --- | --- | --- |
| L0 | [`lib/types.ts`](lib/types.ts) | **The contract.** `ChatMessage`, `ToolDef`, `LlmClient`, `AgentEvent`, `RunAgentOptions/Result`, `SubTask`. Append-only. | built + locked |
| L0 | [`lib/config.ts`](lib/config.ts) | `loadConfig()` — defaults → `env` → overrides, never throws. | built + locked |
| L1 | [`lib/llm.ts`](lib/llm.ts) | DeepSeek client + scripted mock, both behind `LlmClient`. Retry/backoff on 429/5xx/timeouts. | built + locked |
| L1 | [`lib/tools.ts`](lib/tools.ts) | Tool registry: `createCoreTools`, `getTool`, `executeTool`, `toolSummaries`. | built + locked |
| L2 | [`lib/harness.ts`](lib/harness.ts) | `runAgent` — the agentic loop, event stream, termination rules. Returns `{ok:false}` for all failures (including malformed input); does not throw. | built + locked |
| L3 | [`lib/subagent.ts`](lib/subagent.ts) | `runParallel` — worker pool, per-task transcript + tool scoping, ordered results. | built + locked |
| — | `lib/context.ts`, `lib/files.ts`, `lib/search.ts`, `lib/doctor.ts`, `lib/logger.ts` | Persistent memory, project summary, cross-project search, toolchain doctor, rendering. | built + locked |
| — | `scripts/*` | Standalone utilities (`scaffold`, `analyze`, `search`, `commit`, `doctor`). | built + locked |
| **L4** | **`bin/zoocode.ts`** | **CLI adapter: argv parsing, wiring, rendering, exit codes. No agent logic.** | **F5 — this workstream** |
| — | `package.json`, `tsconfig.json`, docs | `bin` entry, npm scripts, verify gate, documentation. | F5 — this workstream |

Rule enforced throughout: each layer imports only from layers below it, and each
layer was frozen before the next began. F5 therefore **imported** the locked
modules and modified none of them.

## 3. Workstream deliverable (F5)

1. `bin/zoocode.ts` — subcommands `tools`, `agent`, `chat`, `run`, `doctor`,
   `analyze`, `search`, `commit`, `scaffold`, `help`, plus a hand-rolled
   `--flag`/`--flag value`/`--flag=value` parser (no deps; `node:readline`,
   `node:process`, `node:child_process`, `node:fs` only).
2. `package.json` — add `"bin": { "zoocode": "bin/zoocode.ts" }` and the
   `zoocode`, `agent`, `doctor`, `verify` scripts; keep the dependency list
   untouched.
3. `tsconfig.json` — add `"bin"` to `include` so the CLI is typechecked.
4. Three unused-symbol cleanups to reach zero `tsc` errors.
5. `README.md` rewrite + `docs/architecture.md` + this `PLAN.md`.

## 4. Definition of done — evidence

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | Typecheck | `npx tsc --noEmit` | **exit 0**, zero errors |
| 2 | Lint | `npx oxlint` | **exit 0** — 0 errors, 1 pre-existing warning (`no-control-regex` in [`lib/doctor.ts`](lib/doctor.ts:38), intentional ANSI stripping) |
| 3 | Tests | `npm test` | **exit 0** — 16 test files collected (15 passed, 1 skipped), **217/217 passed** plus 1 skipped. F6 added 11 lib tests — harness +5, tools +6 — and 5 CLI smoke tests; the skipped suite is `tests/live.test.ts`, the live-network path, which runs only with an API key. |
| 4 | Tool table | `npx tsx bin/zoocode.ts tools` | lists **8 tools**, exit 0 |
| 5 | Smoke test | `npx tsx bin/zoocode.ts agent "say hello" --mock` | exit 0, prints `Hello from the scripted mock LLM — the harness completed a full step with no API key.` **with no API key set** |
| 6 | Doctor JSON | `npx tsx bin/zoocode.ts doctor --json` | exit 0, prints the report (`summary.ok=9`, `healthy: true`) |
| 7 | Parallel stdin | `cmd /c "npx tsx bin/zoocode.ts run - --mock < tasks.json"` (also verified as `Get-Content tasks.json -Raw \| npx tsx bin/zoocode.ts run - --mock` in PowerShell) | exit 0, `[a] ok … [b] ok …` + `2/2 sub-tasks succeeded` |

Additional paths exercised: `agent --events --json` (events on stderr, JSON on
stdout), `chat --mock` over a piped transcript, `analyze lib`, `search … --project
ZooCode`, `help`, and the no-key failure path (`agent x` → exit 1 with
`Missing API key: set DEEPSEEK_API_KEY …` + hint to use `--mock`).

## 5. The three cleanup edits (no behavior change)

| File | Edit | Reason |
| --- | --- | --- |
| [`lib/files.ts`](lib/files.ts:6) | `import { join, relative } from 'node:path'` → `import { join } from 'node:path'` | `relative` was never referenced (TS6133). |
| [`scripts/analyze.ts`](scripts/analyze.ts:10) | `import { collectFiles, getProjectSummary } …` → `import { getProjectSummary } …` | `collectFiles` was never referenced (TS6133). |
| [`scripts/search.ts`](scripts/search.ts:18) | deleted the unused `const SkipDirs = [...]` declaration | The script delegates filtering to PowerShell; the array was dead (TS6133). |

No locked module (`lib/types.ts`, `lib/config.ts`, `lib/llm.ts`, `lib/tools.ts`,
`lib/harness.ts`, `lib/subagent.ts`, `lib/context.ts`, `lib/doctor.ts`,
`lib/search.ts`, `lib/templates.ts`, `lib/git.ts`, `scripts/commit.ts`,
`scripts/scaffold.ts`, `scripts/doctor.ts`, `tests/*`) was modified.

## 6. Key design decisions

- **The CLI owns no logic.** Every subcommand delegates to a locked module and
  translates its `{ ok, data | error }` result into output and an exit code.
- **`--mock` is first-class.** `agent`, `chat`, and `run` all run offline, which
  makes the smoke tests deterministic and CI-safe.
- **stderr for diagnostics.** `--events` (and `--json` payloads on stdout) stay
  separated so the CLI is pipeline-friendly.
- **`process.exitCode`, not `process.exit()`.** Avoids truncating buffered stdout
  on Windows.
- **Backwards compatibility.** The existing `scaffold`, `analyze`, `search`,
  `test`, `test:watch`, and `lint` scripts are preserved unchanged; `commit` and
  `scaffold` are reused rather than reimplemented.

## 7. Deviations

1. **`tsconfig.json` was edited** (added `"bin"` to `include`). Not in the
   original file-ownership list, but without it the new CLI is not part of the
   TypeScript program, `npx tsc --noEmit` would silently skip it, and the "make
   the project typecheck cleanly" requirement would be unmet. It is a one-word
   pure-addition change.
2. **`lib/doctor.ts` retains one oxlint warning** (`no-control-regex`). It is
   pre-existing, intentional (ANSI escape stripping), and lives in a locked file
   F5 does not own — so it was reported rather than "fixed".
3. **Pass-through subcommands invoke `npx tsx <script>`** with `shell: true` and
   per-argument quoting, because `tsx` is a devDependency shim and the harness
   must not add dependencies.

## 8. Build history

| Order | Layer | Workstream | Outcome |
| --- | --- | --- | --- |
| 1 | L0 — contract & config | L0 worker | `lib/types.ts`, `lib/config.ts` locked |
| 2 | L1 — LLM seam & tools | L1 worker | `lib/llm.ts`, `lib/tools.ts`, `lib/logger.ts` locked |
| 3 | L2 — agent loop | L2 worker | `lib/harness.ts` locked |
| 4 | L3 — sub-agents | L3 worker | `lib/subagent.ts` locked |
| 5 | Support — memory/search/doctor/scripts | support workers | context, files, search, doctor, `scripts/*` locked |
| 6 | **L4 — CLI + wiring + docs** | **F5 (this workstream)** | `bin/zoocode.ts`, `package.json`, `tsconfig.json`, `README.md`, `docs/architecture.md`, `PLAN.md` |

Because each layer was frozen before the next started, F5 could only *consume*
the lower layers. The result is a harness whose seams are all enforced by the
compiler and whose end-to-end behaviour is demonstrable with `--mock` and no
network.

## 9. Hardening pass (F6)

An independent QA pass found additive issues. F6 fixed exactly those, with no
architectural rework and no new dependencies:

| # | Fix | Files |
| --- | --- | --- |
| 1 | `runAgent` is genuinely non-throwing: the whole body is wrapped, and `finalText` ignores malformed entries (null / missing `role`). Regression tests cover a null transcript entry, a malformed tool result, and a missing `role`. | [`lib/harness.ts`](lib/harness.ts), [`tests/harness.test.ts`](tests/harness.test.ts) |
| 2 | `RunAgentOptions` gains a typed `model?: string`; the harness reads it directly (no duck-typing) and the CLI no longer casts. | [`lib/types.ts`](lib/types.ts), [`lib/harness.ts`](lib/harness.ts), [`bin/zoocode.ts`](bin/zoocode.ts) |
| 3 | `lib/config.ts` is the single source of truth for the defaults; `lib/harness.ts` and `lib/subagent.ts` import and re-export them (no import cycle). | [`lib/harness.ts`](lib/harness.ts), [`lib/subagent.ts`](lib/subagent.ts) |
| 4 | `run_command` denylist hardened: the `rm -rf /*` bypass is closed (flag order + boundary aware) and Windows/PowerShell destructive forms are covered. Documented as a safety net, not a sandbox. | [`lib/tools.ts`](lib/tools.ts), [`tests/tools.test.ts`](tests/tools.test.ts) |
| 5 | Explicit execution opt-in: `createCoreTools({ allowExec: false })` and the CLI `--no-exec` flag make `run_command` refuse to spawn. Default remains `true`. | [`lib/tools.ts`](lib/tools.ts), [`bin/zoocode.ts`](bin/zoocode.ts), [`tests/tools.test.ts`](tests/tools.test.ts) |
| 6 | The CLI now has automated smoke tests that spawn `npx tsx bin/zoocode.ts …` hermetically (no API key in the child env). | [`tests/cli.test.ts`](tests/cli.test.ts) |
| 7 | Doc overclaims corrected: "NEVER throws" → precise non-throwing wording; "fully test-covered" → exactly what is and is not covered; test counts refreshed. | [`lib/harness.ts`](lib/harness.ts), [`README.md`](README.md), [`docs/architecture.md`](docs/architecture.md), this file |

F6 gate evidence: `npx tsc --noEmit` exit 0 · `npx oxlint` exit 0 (1 pre-existing
warning) · `npm test` exit 0 (15 files / 217 tests passed, 1 file skipped — the
live-network suite) · `npm run verify` green. Test counts re-verified against the
current suite: 218 collected across 16 files, 1 (live) skipped.
