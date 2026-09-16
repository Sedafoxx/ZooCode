/**
 * The environment the agent is actually running in, probed rather than assumed.
 *
 * Why this exists: an observed run spent ten steps discovering the hard way that
 * this is Windows `cmd` — `cat`, `ls -la`, `pwd; ls`, `cmd /c "..."` and
 * `set VAR=x && ...` all failed, and the model only recovered by flailing into
 * `dir /b`. Shell facts are cheap to detect once and expensive to rediscover, so
 * they are injected into the system prompt instead of being left to trial and
 * error. The same run also wrote a scratch file because it believed "output
 * capture is empty" (see `truncateCommandOutput` in `tools.ts` — the real cause
 * was head-only truncation hiding the tail of a long command's output).
 *
 * The facts are split in two on purpose:
 *  - `probeEnvironment()` touches the machine (one `git --version` spawn at most)
 *  - `formatEnvironment()` is pure, so the wording is unit-testable on any OS
 */

import { spawnSync } from 'node:child_process'

export interface EnvironmentFacts {
  platform: NodeJS.Platform
  /** Shell `run_command` actually executes through, as best we can tell. */
  shell: string
  /** True when the shell rejects `;`, `cat`, `ls` and friends. */
  windowsCmd: boolean
  cwd: string
  node: string
  git: string | null
}

/** A single short spawn, and it is allowed to fail: git is optional. */
function probeGit(): string | null {
  try {
    const run = spawnSync('git', ['--version'], { encoding: 'utf-8', timeout: 5_000 })
    if (run.error || run.status !== 0) return null
    const text = String(run.stdout ?? '').trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * What is true of this machine. Never throws: an unprobeable fact is `null` (or a
 * conservative default) rather than an error, because a failed probe must not
 * stop a run.
 */
export function probeEnvironment(cwd?: string): EnvironmentFacts {
  const platform = process.platform
  const windowsCmd = platform === 'win32'
  return {
    platform,
    shell: windowsCmd ? 'cmd.exe' : 'sh-compatible POSIX shell',
    windowsCmd,
    cwd: cwd ?? process.cwd(),
    node: process.version,
    git: probeGit(),
  }
}

/**
 * The injected block. Deliberately blunt and specific: every line here costs one
 * sentence and saves an observed failure. Tested as a string contract, so the
 * rules cannot quietly disappear.
 */
export function formatEnvironment(facts: EnvironmentFacts): string {
  const lines: string[] = [
    '## Environment (probed, do not assume otherwise)',
    `- OS: ${facts.platform}; run_command executes through ${facts.shell}.`,
    `- Working directory: ${facts.cwd}`,
    `- node ${facts.node}${facts.git ? `; ${facts.git}` : '; git not available'}.`,
  ]

  if (facts.windowsCmd) {
    lines.push(
      '- These do NOT exist here: cat, ls, grep, sed, awk, head, tail, rm, touch, cp, mv.',
      '  Use instead: `type <file>` to read, `dir /b` to list, `findstr` to search, `del` to remove.',
      '- `;` is NOT a command separator and `&&` chaining is fragile. Issue ONE command per run_command call.',
      '- You cannot set an env var for one command (`set X=1 && cmd` does not work) and nothing you set persists ' +
        'between calls. If a value is needed, prefer a CLI flag the program already supports.',
    )
  } else {
    lines.push(
      '- cat, ls, grep, sed, awk, head, tail are available.',
      '- `;` and `&&` both chain commands, but ONE command per call stays readable.',
      '- `VAR=value cmd` applies to that command only and does NOT persist between calls.',
    )
  }

  lines.push(
    '- Long output is truncated in the MIDDLE (head and tail are kept) — the end of a run is visible, ' +
      'so read `PASS`/`FAIL` lines before concluding a command produced nothing.',
    '- A non-zero exit is not proof the program is broken: if you ran a test the project provides, ' +
      'read its failing check names first. Re-running the same failing command unchanged is never useful.',
    '- Never start an interactive or long-running process (dev server, watcher, REPL): the harness cannot type into it.',
  )

  return lines.join('\n')
}

/**
 * One-line summary for logs and the JSON payload, so the probed shell is visible
 * without dumping the whole block.
 */
export function summariseEnvironment(facts: EnvironmentFacts): string {
  return `${facts.platform}/${facts.windowsCmd ? 'cmd' : 'posix'} node ${facts.node}`
}
