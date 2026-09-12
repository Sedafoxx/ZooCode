/**
 * CLI smoke tests.
 *
 * These spawn the real CLI (`npx tsx bin/zoocode.ts …`) as a child process so
 * the argv parser, the wiring, and the exit codes are exercised end-to-end.
 * The child environment is built explicitly from `process.env` with
 * `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` removed AND `ZOO_NO_DOTENV=1` set, so
 * the suite cannot silently load a real repo `.env`, hit the network, or spend
 * tokens — the no-key path stays deterministic.
 *
 * If `npx tsx` cannot be spawned at all, the whole suite is skipped rather than
 * failing on an environment issue.
 *
 * Please note: each `npx tsx` child is a cold TypeScript-loader boot (~2-3s of
 * CPU on Windows). `vitest.config.ts` therefore runs test files serially so
 * these spawns never contend with the other subprocess-heavy suites; without
 * that, a boot can exceed the per-spawn timeout and be killed, surfacing as a
 * spurious `status === -1`.
 */

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = 'bin/zoocode.ts'

/**
 * Generous ceiling for a single hermetic CLI spawn. A cold `npx tsx` boot is
 * ~2-3s, but CI machines and parallel tooling can be far slower; the timeout
 * exists to catch a genuine hang, not to bound normal latency.
 */
const TIMEOUT_MS = 120_000

const CORE_TOOL_NAMES = [
  'read_file',
  'write_file',
  'list_files',
  'search_files',
  'run_command',
  'zoo_doctor',
  'zoo_notes',
  'finish',
]

interface CliResult {
  status: number
  stdout: string
  stderr: string
  /** Set when the process was killed (e.g. by our own timeout) rather than exiting. */
  signal: NodeJS.Signals | null
  /** True when the process could not be started at all (vs. a non-zero exit). */
  spawnFailed: boolean
}

/** Quote one argument for the platform shell. */
function quote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Run `npx tsx bin/zoocode.ts <args>` with a hermetic environment.
 *
 * The command is a single shell line (mirroring the passthrough helper in the
 * CLI itself), which preserves arguments containing spaces on both platforms.
 */
function runCli(args: string[]): CliResult {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEEK_MODEL
  // A real `.env` may exist in this repo. Without this opt-out the CLI would
  // load the developer's key, make a real request, and turn the "no key"
  // assertion into a network timeout.
  env.ZOO_NO_DOTENV = '1'
  // Spawned CLI runs must never append to the repo's real usage ledger, even
  // if a test ever drives a client that reports token usage.
  env.ZOO_NO_USAGE = '1'

  const line = `npx tsx ${CLI} ${args.map(quote).join(' ')}`

  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(line, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: TIMEOUT_MS,
      env,
      windowsHide: true,
      shell: true,
    })
  } catch {
    return { status: -1, stdout: '', stderr: '', signal: null, spawnFailed: true }
  }

  return {
    status: typeof result.status === 'number' ? result.status : -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    signal: result.signal ?? null,
    spawnFailed: Boolean(result.error),
  }
}

// Probe once at collection time so the suite can skip on an unusable
// environment. The result is reused for the `help` assertion below, so the
// probe costs no extra spawn.
const probe = runCli(['help'])
const cliAvailable = !probe.spawnFailed

/**
 * Fail with a diagnostic that distinguishes "the CLI exited wrong" from
 * "the CLI was killed before it could exit" — the latter means the machine was
 * too loaded for a cold `npx tsx` boot, not that the CLI is broken.
 */
function expectExit(result: CliResult, code: number): void {
  if (result.status === -1 && result.signal !== null) {
    throw new Error(
      `CLI was killed by ${result.signal} after ${TIMEOUT_MS}ms before it could exit. ` +
        'This is spawn contention, not a CLI failure — ensure vitest runs ' +
        'test files serially (see vitest.config.ts).',
    )
  }
  expect(result.status).toBe(code)
}

describe.skipIf(!cliAvailable)('zoocode CLI smoke tests', () => {
  it(
    '`tools` exits 0 and lists the 8 core tools',
    () => {
      const result = runCli(['tools'])
      expectExit(result, 0)
      expect(result.stdout).toContain('Core tools (8)')
      for (const name of CORE_TOOL_NAMES) {
        expect(result.stdout).toContain(name)
      }
      expect(result.stdout).toContain('run_command')
      expect(result.stdout).toContain('finish')

      // The JSON form lets us assert the count exactly.
      const json = runCli(['tools', '--json'])
      expectExit(json, 0)
      const parsed = JSON.parse(json.stdout) as { name: string }[]
      expect(parsed).toHaveLength(8)
      expect(parsed.map((entry) => entry.name).sort()).toEqual([...CORE_TOOL_NAMES].sort())
    },
    TIMEOUT_MS,
  )

  it(
    '`agent "say hello" --mock --json` exits 0 with ok:true JSON',
    () => {
      const result = runCli(['agent', 'say hello', '--mock', '--json'])
      expectExit(result, 0)
      const parsed = JSON.parse(result.stdout) as { ok: boolean; final: string }
      expect(parsed.ok).toBe(true)
      expect(parsed.final.length).toBeGreaterThan(0)
    },
    TIMEOUT_MS,
  )

  it(
    '`doctor --json` exits 0 with a checks array',
    () => {
      const result = runCli(['doctor', '--json'])
      expectExit(result, 0)
      const parsed = JSON.parse(result.stdout) as { checks: unknown[] }
      expect(Array.isArray(parsed.checks)).toBe(true)
    },
    TIMEOUT_MS,
  )

  it(
    '`agent "x"` without a key and without --mock exits 1 mentioning the API key',
    () => {
      const result = runCli(['agent', 'x'])
      expectExit(result, 1)
      expect(`${result.stdout}${result.stderr}`).toContain('API key')
    },
    TIMEOUT_MS,
  )

  it(
    '`help` documents the --no-exec opt-out flag',
    () => {
      // Reuse the collection-time probe instead of spawning a second time.
      expectExit(probe, 0)
      expect(probe.stdout).toContain('--no-exec')
    },
    TIMEOUT_MS,
  )

  it(
    '`help` documents the execution policy flags and the CLI default',
    () => {
      // Reuse the collection-time probe instead of spawning a second time.
      expectExit(probe, 0)
      expect(probe.stdout).toContain('--exec-policy')
      expect(probe.stdout).toContain('--allow-exec')
      expect(probe.stdout).toContain('allowlist')
    },
    TIMEOUT_MS,
  )

  it(
    'the CLI default (allowlist) refuses a non-allowlisted command and runs an allowlisted one',
    () => {
      // Nothing is spawned here (`deno` would be refused, `node --version` is
      // read-only), so this stays fully offline.
      const refused = runCli(['agent', 'mock-run: deno --version', '--mock', '--json'])
      expectExit(refused, 0)
      expect(refused.stderr).toContain('exec-policy=allowlist')
      const refusedJson = JSON.parse(refused.stdout) as { final: string }
      // A refusal echoes the command and produces no output — `deno` never ran.
      expect(refusedJson.final).toBe('deno --version')

      const allowed = runCli(['agent', 'mock-run: node --version', '--mock', '--json'])
      expectExit(allowed, 0)
      const allowedJson = JSON.parse(allowed.stdout) as { final: string }
      expect(allowedJson.final).toMatch(/^v\d+\./)
    },
    TIMEOUT_MS,
  )

  it(
    'the CLI default refuses a destructive denylist command before it can run',
    () => {
      const result = runCli(['agent', 'mock-run: rm -rf /', '--mock', '--json', '--events'])
      expectExit(result, 0)
      // The refusal echoes the command (content) and the event stream records
      // the failed tool call; the command itself was never handed to the shell.
      const parsed = JSON.parse(result.stdout) as { final: string }
      expect(parsed.final).toBe('rm -rf /')
      expect(result.stderr).toContain('tool_result run_command ok=false')
    },
    TIMEOUT_MS,
  )

  it(
    '`agent --exec-policy ask` fails closed (no interactive approver)',
    () => {
      const result = runCli(['agent', 'x', '--exec-policy', 'ask'])
      expectExit(result, 1)
      expect(`${result.stdout}${result.stderr}`).toContain('--exec-policy allowlist or --allow-exec')
    },
    TIMEOUT_MS,
  )

  it(
    'rejects an unknown --exec-policy value',
    () => {
      const result = runCli(['agent', 'x', '--exec-policy', 'yolo'])
      expectExit(result, 1)
      expect(`${result.stdout}${result.stderr}`).toContain('Unknown --exec-policy value')
    },
    TIMEOUT_MS,
  )

  it(
    '`usage --json` is read-only, exits 0, and prints the whole summary',
    () => {
      const result = runCli(['usage', '--json'])
      expectExit(result, 0)
      const parsed = JSON.parse(result.stdout) as {
        overall: { runs: number; totalTokens: number; estimatedCostUsd: number }
        entries: number
      }
      expect(typeof parsed.overall).toBe('object')
      expect(typeof parsed.overall.runs).toBe('number')
      expect(typeof parsed.overall.totalTokens).toBe('number')
      expect(typeof parsed.entries).toBe('number')
    },
    TIMEOUT_MS,
  )

  it(
    '`help` documents the usage command',
    () => {
      expectExit(probe, 0)
      expect(probe.stdout).toContain('zoocode usage')
    },
    TIMEOUT_MS,
  )

  it(
    '`help` documents `improve`, its warning, and its flags',
    () => {
      // Reuse the collection-time probe instead of spawning a second time.
      expectExit(probe, 0)
      expect(probe.stdout).toContain('zoocode improve')
      // The warning that this command edits the repository it is run from.
      expect(probe.stdout).toContain("edits this repository's own source")
      expect(probe.stdout).toContain('--verify-cmd')
      expect(probe.stdout).toContain('--max-steps')
      expect(probe.stdout).toContain('--dry-run')
      expect(probe.stdout).toContain('--no-branch')
      // The forced strict policy is spelled out.
      expect(probe.stdout).toContain('allowlist')
    },
    TIMEOUT_MS,
  )

  it(
    '`improve` without a key exits 1 with a clear message (no mock fallback)',
    () => {
      // The child env sets ZOO_NO_DOTENV=1 and deletes DEEPSEEK_API_KEY, so this
      // exercises the real "no key" path without ever starting the loop.
      const result = runCli(['improve', 'tidy up the logger module'])
      expectExit(result, 1)
      const combined = `${result.stdout}${result.stderr}`
      expect(combined).toContain('API key')
      // It must not have reached the loop: no report, no branch, no agent.
      expect(combined).not.toContain('self-modification report')
    },
    TIMEOUT_MS,
  )
})
