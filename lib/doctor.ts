/**
 * Environment doctor.
 *
 * Verifies the local toolchain (node, npm, git, npx) plus ZooCode's own repo
 * state (repo root present, package.json parseable). Fully self-contained —
 * no imports from other lib modules — and never throws.
 */

import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface CheckResult {
  name: string
  status: CheckStatus
  detail?: string
  required: boolean
}

export interface DoctorReport {
  checks: CheckResult[]
  summary: { ok: number; warn: number; fail: number }
  /** True when there are no `fail` checks. */
  healthy: boolean
}

const EXEC_OPTS: ExecFileSyncOptions = {
  timeout: 8000,
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
}

/** Flatten multi-line / ANSI-colored output into a single readable line. */
function tidy(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Build a human-readable failure description from a thrown exec error. */
function describeFailure(err: unknown): { message: string; notFound: boolean } {
  const stderr = (err as { stderr?: string | Buffer }).stderr
  const message = stderr !== undefined ? String(stderr) : errorText(err)
  const code = (err as { code?: unknown }).code
  const notFound =
    code === 'ENOENT' ||
    code === 'EINVAL' ||
    code === 'UNKNOWN' ||
    /ENOENT|not recognized as an internal or external command/i.test(message)
  return { message: tidy(message), notFound }
}

/** Run `<bin> <args>` with a short timeout; never throws. */
function runCommand(bin: string, args: string[]): {
  ok: boolean
  stdout: string
  failure?: { message: string; notFound: boolean }
} {
  try {
    const stdout = execFileSync(bin, args, EXEC_OPTS) as string
    return { ok: true, stdout: String(stdout) }
  } catch (err) {
    // On Windows, `.cmd`/`.bat` shims (e.g. npm, npx) cannot be spawned
    // directly; retry once through the system shell.
    if (process.platform === 'win32' && describeFailure(err).notFound) {
      try {
        const stdout = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/c', bin, ...args], EXEC_OPTS) as string
        return { ok: true, stdout: String(stdout) }
      } catch (err2) {
        // The direct spawn already signaled "not found"; a failing cmd.exe
        // retry therefore means the command truly does not exist. (The
        // message may be localized, so keep the notFound flag from the
        // original spawn rather than re-deriving it from stderr text.)
        const failure = describeFailure(err2)
        return { ok: false, stdout: '', failure: { message: failure.message, notFound: true } }
      }
    }
    return { ok: false, stdout: '', failure: describeFailure(err) }
  }
}

/**
 * Run `<bin> <args>` via execFile with a short timeout. Returns `ok` when the
 * binary exists and exits 0, `fail` when a required tool cannot run, and
 * `warn` when an optional tool is missing.
 */
export function checkTool(bin: string, args: string[] = [], required = true): CheckResult {
  const name = args.length > 0 ? `${bin} ${args.join(' ')}` : bin
  const run = runCommand(bin, args)
  if (run.ok) {
    const detail = tidy(run.stdout)
    return detail ? { name, status: 'ok', detail, required } : { name, status: 'ok', required }
  }
  const failure = run.failure ?? { message: 'command failed', notFound: false }
  if (failure.notFound) {
    const detail = required ? `${bin} not found` : `${bin} not found — optional (install via npm i -D ${bin})`
    return { name, status: required ? 'fail' : 'warn', detail, required }
  }
  return { name, status: required ? 'fail' : 'warn', detail: failure.message, required }
}

/** True if any of the common cross-platform shim names exist in `binDir`. */
function binExists(binDir: string, name: string): boolean {
  const candidates = [name, `${name}.cmd`, `${name}.exe`, `${name}.ps1`, `${name}.bat`]
  return candidates.some((candidate) => existsSync(join(binDir, candidate)))
}

/** Walk up from `start` looking for the ZooCode repo root (package.json name "zoocode"). */
function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start)
  for (;;) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: unknown }
        if (pkg.name === 'zoocode') return dir
      } catch {
        // Unparseable package.json — keep walking up toward the filesystem root.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Aggregate the full doctor report: required toolchain checks (node, npm, git,
 * npx), optional tooling in `node_modules/.bin` (tsx, vitest, oxlint), and the
 * ZooCode repo root / package.json state. Never throws.
 */
export function runDoctor(): { ok: boolean; data?: DoctorReport; error?: string } {
  try {
    const checks: CheckResult[] = [
      checkTool('node', ['--version']),
      checkTool('npm', ['--version']),
      checkTool('git', ['--version']),
      checkTool('npx', ['--version']),
    ]

    const repoRoot = findRepoRoot(process.cwd())
    const binDir = repoRoot ? join(repoRoot, 'node_modules', '.bin') : undefined

    for (const tool of ['tsx', 'vitest', 'oxlint']) {
      if (binDir && binExists(binDir, tool)) {
        checks.push({ name: tool, status: 'ok', detail: 'present in node_modules/.bin', required: false })
      } else {
        checks.push({
          name: tool,
          status: 'warn',
          detail: `${tool} not found in node_modules/.bin — install via npm i -D ${tool}`,
          required: false,
        })
      }
    }

    if (repoRoot) {
      checks.push({ name: 'ZooCode repo root', status: 'ok', detail: repoRoot, required: true })
    } else {
      checks.push({
        name: 'ZooCode repo root',
        status: 'fail',
        detail: 'no package.json with name "zoocode" found from current directory',
        required: true,
      })
    }

    const pkgPath = repoRoot ? join(repoRoot, 'package.json') : join(process.cwd(), 'package.json')
    try {
      const raw = readFileSync(pkgPath, 'utf-8')
      JSON.parse(raw)
      checks.push({ name: 'package.json', status: 'ok', detail: pkgPath, required: true })
    } catch (err) {
      checks.push({ name: 'package.json', status: 'fail', detail: `unparseable: ${errorText(err)}`, required: true })
    }

    const summary = { ok: 0, warn: 0, fail: 0 }
    for (const check of checks) {
      summary[check.status] += 1
    }
    const healthy = summary.fail === 0

    return { ok: true, data: { checks, summary, healthy } }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}
