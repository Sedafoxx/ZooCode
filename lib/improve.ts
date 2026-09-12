/**
 * The self-improvement loop (S3) — the one feature that lets the harness modify
 * **its own source repository**.
 *
 * This is the highest-risk component in the project, so it is built as a set of
 * mandatory rails rather than a convenience wrapper around `runAgent`:
 *
 *  1. **Preflight.** The target must be a git repo with a CLEAN working tree.
 *     Anything else is refused before a single byte is written. `dryRun` stops
 *     here and reports the plan.
 *  2. **Branch isolation.** By default the loop creates and checks out
 *     `zoo/improve-<timestamp>` FIRST, so nothing ever lands on the user's
 *     current branch. If the branch cannot be created, the run aborts.
 *  3. **Repo-scoped write guard** ([`guardTools`](./improve.ts)). `write_file`
 *     is wrapped so the resolved target must live inside the repository root,
 *     and a hard denylist (`.env`, `.env.*`, `.git/`, `node_modules/`,
 *     `.zoo/usage.jsonl`, `.claude/`) is refused even inside it. Refusals return
 *     `{ ok: false, error: 'Refused: …', content: <path> }` and never touch disk.
 *  4. **Command guard.** `run_command` runs under
 *     `createExecPolicy({ mode: 'allowlist' })` — the strict workshop allowlist,
 *     never `allow` — and is additionally wrapped so its `cwd` must be inside the
 *     repository root.
 *  5. **Bounded work.** `maxSteps` (default {@link DEFAULT_IMPROVE_MAX_STEPS}) is
 *     enforced by the harness; exhaustion still yields a full report.
 *  6. **Verification gate.** After the agent stops, `verifyRepo` runs the real
 *     gate command (default `npm run verify`). A red gate forces `ok: false` even
 *     when the agent claimed success — success is never asserted without green.
 *  7. **No unreviewed commits.** `commit` defaults to `false`. When `true`, the
 *     changes are staged and committed with a conventional message; otherwise
 *     they stay on the branch for a human to review.
 *
 * `runImprovement` **never throws**: every failure path resolves with a populated
 * {@link ImproveReport} carrying `ok: false` and `error`.
 *
 * All git access is via [`lib/git.ts`](./git.ts) where an equivalent helper
 * exists (`isGitRepo`, `getStatus`, `stageAll`, `commit`); the small branch /
 * diff / rev-parse helpers that `lib/git.ts` does not expose are local to this
 * module so no existing module changes behaviour.
 */

import { exec, execSync } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createMessages, DEFAULT_MAX_STEPS, runAgent } from './harness.js'
import { commit as gitCommit, getStatus, isGitRepo, stageAll } from './git.js'
import { createExecPolicy } from './policy.js'
import { createCoreTools } from './tools.js'
import type {
  AgentEvent,
  LlmClient,
  RunAgentOptions,
  RunAgentResult,
  ToolDef,
} from './types.js'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface VerifyResult {
  ok: boolean
  command: string
  exitCode: number
  /** Last ~40 lines of combined stdout/stderr (the report-facing excerpt). */
  tail: string
  durationMs: number
}

export interface ImproveOptions {
  llm: LlmClient
  goal: string
  /** The repository to improve; defaults to `process.cwd()`. */
  cwd?: string
  maxSteps?: number
  /** Defaults to `npm run verify`. */
  verifyCommand?: string
  /** Injectable gate runner (tests); defaults to {@link verifyRepo}. */
  runVerify?: (cwd: string, command: string) => Promise<VerifyResult>
  /** Create and check out `zoo/improve-<timestamp>` first. Defaults to `true`. */
  createBranch?: boolean
  /** Commit the result. Defaults to `false` — never commit unless asked. */
  commit?: boolean
  /** Preflight only: no branch, no agent, no writes. */
  dryRun?: boolean
  systemPrompt?: string
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
}

export interface ImproveReport {
  ok: boolean
  goal: string
  branch?: string
  preflight: { isGitRepo: boolean; clean: boolean; notes: string[] }
  agent?: RunAgentResult
  changedFiles: string[]
  diffStat: string
  verify?: VerifyResult
  committed: boolean
  error?: string
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The gate a human would run. Intentionally the same command, not a replica. */
export const DEFAULT_VERIFY_COMMAND = 'npm run verify'

/** Bounded work: same default as the rest of the harness (`lib/config.ts`). */
export const DEFAULT_IMPROVE_MAX_STEPS = DEFAULT_MAX_STEPS

/**
 * Generous ceiling for the gate: `npm run verify` boots oxlint, tsc and vitest,
 * which can take minutes on a cold cache. The limit exists to catch a hang, not
 * to bound normal latency.
 */
const VERIFY_TIMEOUT_MS = 600_000

/** Size of the output excerpt kept in `VerifyResult.tail`. */
const VERIFY_TAIL_LINES = 40

/** Max combined output buffered from the gate before it is truncated. */
const VERIFY_MAX_BUFFER = 32 * 1024 * 1024

/** The tool whose `path` argument the write guard classifies. */
const WRITE_TOOL = 'write_file'

/** The tool whose `cwd` argument the command guard confines to the repo root. */
const RUN_TOOL = 'run_command'

/** Directories that are always refused, even inside the repository root. */
const FORBIDDEN_DIRS = new Set(['.git', 'node_modules', '.claude'])

/** The one ledger file that must never be rewritten by an improvement run. */
const FORBIDDEN_FILE = '.zoo/usage.jsonl'

/** `.env` and every `.env.*` variant. */
const ENV_FILE = /^\.env(\.|$)/

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Normalize a path to forward slashes for stable, portable messages. */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** Join combined process output into one string, trimming trailing blanks. */
function combineOutput(stdout: string | Buffer, stderr: string | Buffer): string {
  const out = String(stdout ?? '').trimEnd()
  const errOut = String(stderr ?? '').trimEnd()
  return [out, errOut].filter((part) => part.length > 0).join('\n')
}

/** Keep only the final `maxLines` non-trailing-empty lines of `text`. */
function tailOf(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.slice(-maxLines).join('\n')
}

/** Extract stderr text (or the message) from a thrown `execSync` error. */
function execErrorText(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = (err as { stderr?: string | Buffer }).stderr
    if (stderr !== undefined) {
      const text = Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : String(stderr)
      if (text.trim()) return text.trim()
    }
  }
  return errorMessage(err)
}

/**
 * Run one git subcommand in `cwd`. Never throws.
 *
 * `output` is the raw stdout on success (empty on failure); `error` carries the
 * extracted stderr so callers can explain what went wrong.
 */
function git(cwd: string, args: string): { ok: boolean; output: string; error?: string } {
  try {
    const output = execSync(`git ${args}`, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      windowsHide: true,
    }) as string
    return { ok: true, output }
  } catch (err) {
    return { ok: false, output: '', error: execErrorText(err) }
  }
}

/** The currently checked-out branch, or `undefined` for a detached HEAD. */
function currentBranch(cwd: string): string | undefined {
  const result = git(cwd, 'rev-parse --abbrev-ref HEAD')
  const name = result.ok ? result.output.trim() : ''
  if (name.length === 0 || name === 'HEAD') return undefined
  return name
}

/** Compact, sortable UTC stamp used to name the isolation branch. */
function timestamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `${date}-${time}`
}

/** Conventional commit subject describing the requested goal. */
function commitMessage(goal: string): string {
  const subject = goal.replace(/\s+/g, ' ').trim().slice(0, 60)
  return `chore(improve): ${subject}`
}

/* -------------------------------------------------------------------------- */
/* Verification gate                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Run the repository's gate command and capture its result.
 *
 * DELIBERATELY SHELLS OUT: the gate must be *the same command a human would
 * run*, in the same working directory, with the same environment — reimplementing
 * `oxlint && tsc && vitest` here would let the replica and the real gate drift,
 * which is exactly the failure mode this gate exists to prevent. Never throws.
 */
export function verifyRepo(
  cwd: string,
  command: string = DEFAULT_VERIFY_COMMAND,
): Promise<VerifyResult> {
  const startedAt = Date.now()
  return new Promise<VerifyResult>((resolvePromise) => {
    const finish = (exitCode: number, output: string): void => {
      resolvePromise({
        ok: exitCode === 0,
        command,
        exitCode,
        tail: tailOf(output, VERIFY_TAIL_LINES),
        durationMs: Date.now() - startedAt,
      })
    }

    try {
      exec(
        command,
        { cwd, timeout: VERIFY_TIMEOUT_MS, maxBuffer: VERIFY_MAX_BUFFER, windowsHide: true },
        (err, stdout, stderr) => {
          const output = combineOutput(stdout, stderr)
          if (!err) {
            finish(0, output)
            return
          }
          const code = (err as { code?: unknown }).code
          if (typeof code === 'number') {
            finish(code, output.length > 0 ? output : `exit code ${code}`)
            return
          }
          const message = errorMessage(err)
          finish(-1, output.length > 0 ? `${output}\n${message}` : message)
        },
      )
    } catch (err) {
      finish(-1, errorMessage(err))
    }
  })
}

/**
 * Invoke an (injected or real) gate runner without trusting it: a runner that
 * throws or returns a malformed object becomes a failing {@link VerifyResult}.
 */
async function safeRunVerify(
  runner: (cwd: string, command: string) => Promise<VerifyResult>,
  cwd: string,
  command: string,
): Promise<VerifyResult> {
  try {
    const result = await runner(cwd, command)
    if (
      result !== null &&
      typeof result === 'object' &&
      typeof result.ok === 'boolean' &&
      typeof result.exitCode === 'number'
    ) {
      return {
        ok: result.ok,
        command: typeof result.command === 'string' ? result.command : command,
        exitCode: result.exitCode,
        tail: typeof result.tail === 'string' ? result.tail : '',
        durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
      }
    }
    return {
      ok: false,
      command,
      exitCode: -1,
      tail: 'verification runner returned an invalid result',
      durationMs: 0,
    }
  } catch (err) {
    return {
      ok: false,
      command,
      exitCode: -1,
      tail: `verification runner threw: ${errorMessage(err)}`,
      durationMs: 0,
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Repo-scoped guards                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Why `rawPath` may not be written, or `undefined` when it is allowed.
 *
 * Containment is decided LEXICALLY (`path.resolve` normalizes `.` / `..` and
 * absolute segments) and symlinks are deliberately NOT resolved: the guard is a
 * belt-and-braces layer in front of a repository that is already isolated on its
 * own branch, not a sandbox. A path that cannot even be normalized is refused.
 */
function writeRefusal(rawPath: string, root: string): string | undefined {
  if (rawPath.trim().length === 0) return 'the "path" argument is empty'

  let target: string
  try {
    // An absolute argument wins over `root`; `..` segments are normalized here.
    target = resolve(root, rawPath)
  } catch (err) {
    return `the path could not be normalized: ${errorMessage(err)}`
  }

  const rel = relative(root, target)
  if (rel.length === 0) {
    return `"${rawPath}" resolves to the repository root itself, which is a directory`
  }
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `"${rawPath}" resolves outside the repository root (${root})`
  }

  const parts = rel.split(sep).filter((part) => part.length > 0)
  const forbiddenDir = parts.find((part) => FORBIDDEN_DIRS.has(part))
  if (forbiddenDir !== undefined) {
    return `"${rawPath}" is inside the protected "${forbiddenDir}/" directory`
  }

  const base = parts[parts.length - 1] ?? ''
  if (ENV_FILE.test(base)) {
    return `"${rawPath}" is an environment file, which is never written`
  }
  if (toPosix(rel) === FORBIDDEN_FILE) {
    return `"${rawPath}" is the local usage ledger, which is never written`
  }
  return undefined
}

/** Wrap `write_file` so its target must be inside `root` and off the denylist. */
function guardWrite(tool: ToolDef, root: string): ToolDef {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    handler: async (args, ctx) => {
      const raw = typeof args?.path === 'string' ? args.path : ''
      const reason = writeRefusal(raw, root)
      if (reason !== undefined) {
        return { ok: false, error: `Refused: ${reason}`, content: raw }
      }
      return tool.handler(args, ctx)
    },
  }
}

/** Wrap `run_command` so its working directory stays inside `root`. */
function guardCommand(tool: ToolDef, root: string): ToolDef {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    handler: async (args, ctx) => {
      const requested = typeof args?.cwd === 'string' && args.cwd.length > 0 ? args.cwd : ctx.cwd
      let target: string
      try {
        target = resolve(root, requested)
      } catch (err) {
        return {
          ok: false,
          error: `Refused: the command cwd could not be resolved: ${errorMessage(err)}`,
          content: String(requested),
        }
      }
      const rel = relative(root, target)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return {
          ok: false,
          error: `Refused: the command cwd "${requested}" is outside the repository root (${root})`,
          content: String(requested),
        }
      }
      return tool.handler(args, ctx)
    },
  }
}

/**
 * Return a copy of `tools` in which every file-mutating / shell tool is confined
 * to `root`. `write_file` is path-checked against the repository root and the
 * protected-path denylist; `run_command` keeps its policy gate (applied by the
 * caller via `createCoreTools({ policy })`) and is additionally barred from
 * running outside `root`. Every other tool is returned untouched.
 */
export function guardTools(tools: ToolDef[], root: string): ToolDef[] {
  if (!Array.isArray(tools)) return []
  const repoRoot = resolve(root)
  return tools.map((tool) => {
    if (tool?.name === WRITE_TOOL) return guardWrite(tool, repoRoot)
    if (tool?.name === RUN_TOOL) return guardCommand(tool, repoRoot)
    return tool
  })
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

/** The system prompt that states every rail the loop enforces. */
export function defaultImproveSystemPrompt(goal: string): string {
  return [
    "You are improving THIS repository's own source code.",
    `Goal: ${goal}`,
    '',
    'Hard rules (enforced by the harness, not just advisory):',
    '- You may only write files inside the repository root. Writes outside it — and to `.env`, `.env.*`, anything under `.git/`, `node_modules/`, `.claude/`, or `.zoo/usage.jsonl` — are refused before touching disk.',
    '- `run_command` is restricted to the workshop allowlist (node / npm / npx / tsx / tsc / vitest / oxlint / git / …) and its working directory must stay inside the repository root.',
    '- Work on the current branch only. Never create branches, commit, push, or reset anything.',
    '- Keep the change minimal and in the existing style: ESM with `.js` import extensions, 2-space indent, named exports, `{ ok, data?, error? }` result objects, errors caught not thrown.',
    '- Add or update tests for everything you change and run them with `npx vitest run <file>` as you go.',
    '- The mandatory gate (`npm run verify`) runs after you stop. You cannot declare success — only a green gate can.',
    '- When the work is done, call the `finish` tool with a concise summary of what changed and why.',
  ].join('\n')
}

/* -------------------------------------------------------------------------- */
/* Diff collection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Collect the agent's footprint: the changed file list plus a `git diff --stat`.
 *
 * Untracked files do not appear in `git diff`, so they are made visible by
 * staging everything first (`stageAll`) and reading `git diff --cached --stat`.
 * When the run is not going to commit, the index is restored with
 * `git reset -q`, which leaves the working tree exactly as the agent left it —
 * changes present, unstaged, awaiting review.
 */
function collectDiff(root: string, keepStaged: boolean): { changedFiles: string[]; diffStat: string } {
  let changedFiles: string[] = []
  let diffStat = ''

  const staged = stageAll(root)
  if (staged.ok) {
    // The staged diff is the authoritative list: unlike `git status`, it expands
    // a brand-new directory into the individual files the agent created.
    const names = git(root, 'diff --cached --name-only')
    if (names.ok) {
      changedFiles = names.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    }
    const stat = git(root, 'diff --cached --stat')
    if (stat.ok) diffStat = stat.output.trim()
    if (!keepStaged) git(root, 'reset -q')
  }

  if (changedFiles.length === 0) {
    const status = getStatus(root)
    if (status.ok) {
      for (const file of status.data ?? []) changedFiles.push(file.path)
    }
  }
  if (diffStat.length === 0) {
    const stat = git(root, 'diff --stat')
    if (stat.ok) diffStat = stat.output.trim()
  }
  return { changedFiles, diffStat }
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

/** Build the report skeleton so every failure path can populate it in place. */
function baseReport(goal: string): ImproveReport {
  return {
    ok: false,
    goal,
    preflight: { isGitRepo: false, clean: false, notes: [] },
    changedFiles: [],
    diffStat: '',
    committed: false,
  }
}

/**
 * Run one self-improvement pass over `options.cwd`.
 *
 * See the module header for the rails. Resolves (never rejects) with a fully
 * populated {@link ImproveReport}; `ok` is true only when the preflight passed,
 * the agent finished, and the mandatory verification gate was green.
 */
export async function runImprovement(options: ImproveOptions): Promise<ImproveReport> {
  const goal = typeof options?.goal === 'string' ? options.goal.trim() : ''
  const root = resolve(options?.cwd ?? process.cwd())
  const report = baseReport(goal)
  const notes = report.preflight.notes

  try {
    if (goal.length === 0) {
      report.error = 'improve requires a non-empty goal'
      return report
    }
    if (!options?.llm || typeof options.llm.chat !== 'function') {
      report.error = 'improve requires an LlmClient — there is no mock fallback on this path'
      return report
    }

    /* ---- 1. Preflight ---------------------------------------------------- */

    if (!isGitRepo(root)) {
      notes.push(`not a git repository: ${root}`)
      report.error =
        `Refusing to improve ${root}: it is not a git repository. ` +
        'The loop requires git so it can isolate its work on a branch.'
      return report
    }
    report.preflight.isGitRepo = true

    const status = getStatus(root)
    if (!status.ok) {
      report.error =
        `Refusing to improve ${root}: the git working tree could not be read ` +
        `(${status.error ?? 'unknown error'}).`
      return report
    }

    const dirty = status.data ?? []
    report.preflight.clean = dirty.length === 0
    if (!report.preflight.clean) {
      const preview = dirty.slice(0, 5).map((file) => file.path).join(', ')
      notes.push(
        `${dirty.length} uncommitted change(s): ${preview}${dirty.length > 5 ? ', …' : ''}`,
      )
      report.error =
        `Refusing to improve: the working tree is not clean (${dirty.length} file(s) changed). ` +
        'Commit or stash your work first — the loop never runs on a dirty tree.'
      return report
    }
    notes.push('working tree is clean')

    const wantsBranch = options.createBranch !== false
    const branchName = `zoo/improve-${timestamp()}`
    notes.push(
      wantsBranch
        ? `branch isolation: will create and check out ${branchName}`
        : 'branch isolation disabled (createBranch=false): work stays on the current branch',
    )
    notes.push(
      options.commit === true
        ? 'commit: enabled — the result will be committed after a green verify'
        : 'commit: disabled (default) — changes will stay on the branch for review',
    )

    /* ---- dry run: stop here, report the plan ----------------------------- */

    if (options.dryRun === true) {
      notes.push('dry run: no branch was created, no agent ran, nothing was written')
      report.ok = true
      return report
    }

    /* ---- 2. Branch isolation -------------------------------------------- */

    if (wantsBranch) {
      const created = git(root, `checkout -b ${branchName}`)
      if (!created.ok) {
        report.error =
          `Could not create the isolation branch ${branchName}: ` +
          `${created.error ?? 'unknown git error'}. Nothing was modified.`
        return report
      }
      report.branch = branchName
      notes.push(`checked out ${branchName}`)
    } else {
      const branch = currentBranch(root)
      if (branch !== undefined) report.branch = branch
      notes.push(`staying on ${branch ?? 'a detached HEAD'}`)
    }

    /* ---- 3/4/5. The agent, on guarded tools and a bounded budget --------- */

    // The library default is 'allow'; the improvement loop must never use it.
    const policy = createExecPolicy({ mode: 'allowlist' })
    const tools = guardTools(createCoreTools({ policy }), root)

    const agentOptions: RunAgentOptions = {
      llm: options.llm,
      tools,
      messages: createMessages(goal, options.systemPrompt ?? defaultImproveSystemPrompt(goal)),
      cwd: root,
      maxSteps: options.maxSteps ?? DEFAULT_IMPROVE_MAX_STEPS,
    }
    if (options.signal !== undefined) agentOptions.signal = options.signal
    if (options.onEvent !== undefined) agentOptions.onEvent = options.onEvent

    const agent = await runAgent(agentOptions)
    report.agent = agent

    /* ---- Diff ------------------------------------------------------------ */

    const diff = collectDiff(root, options.commit === true)
    report.changedFiles = diff.changedFiles
    report.diffStat = diff.diffStat

    /* ---- 6. Verification gate ------------------------------------------- */

    const verifyCommand = options.verifyCommand ?? DEFAULT_VERIFY_COMMAND
    const runner = options.runVerify ?? verifyRepo
    report.verify = await safeRunVerify(runner, root, verifyCommand)

    if (!report.verify.ok) {
      report.error =
        `Verification failed: \`${report.verify.command}\` exited ${report.verify.exitCode}. ` +
        `The changes stay on ${report.branch ?? 'the current branch'} for inspection — nothing was committed.`
      return report
    }

    if (!agent.ok) {
      report.error =
        `The agent did not finish successfully (${agent.error ?? 'unknown error'}), ` +
        'even though the gate passed. Nothing was committed.'
      return report
    }

    /* ---- 7. Commit (opt-in) --------------------------------------------- */

    if (options.commit === true) {
      const staged = stageAll(root)
      if (!staged.ok) {
        report.error = `Nothing was committed: staging failed (${staged.error ?? 'unknown error'}).`
        return report
      }
      const message = commitMessage(goal)
      const committed = gitCommit(root, message)
      if (!committed.ok) {
        report.error = `Nothing was committed: git commit failed (${committed.error ?? 'unknown error'}).`
        return report
      }
      report.committed = true
      notes.push(`committed ${committed.data?.hash ?? ''}`.trim())
    } else {
      notes.push(
        `not committed: the work sits on ${report.branch ?? 'the current branch'} awaiting human review`,
      )
    }

    report.ok = true
    return report
  } catch (err) {
    // Safety net: no failure may escape as a rejection.
    report.error = `The improvement loop failed unexpectedly: ${errorMessage(err)}`
    return report
  }
}
