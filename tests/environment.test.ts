/**
 * The environment block is a prompt contract, so it is tested as a string.
 *
 * These assertions exist because of a measured cost: one run spent ten steps
 * discovering that `cat`, `ls -la`, `pwd; ls`, `cmd /c "..."` and
 * `set VAR=x && ...` all fail on Windows cmd. If a line below is ever removed,
 * that cost comes back, so the lines are pinned here rather than trusted to
 * survive a refactor.
 */

import { describe, expect, it } from 'vitest'

import {
  formatEnvironment,
  probeEnvironment,
  summariseEnvironment,
  type EnvironmentFacts,
} from '../lib/environment.js'

const WINDOWS: EnvironmentFacts = {
  platform: 'win32',
  shell: 'cmd.exe',
  windowsCmd: true,
  cwd: 'C:\\proj\\app',
  node: 'v20.11.0',
  git: 'git version 2.43.0',
}

const POSIX: EnvironmentFacts = {
  platform: 'linux',
  shell: 'sh-compatible POSIX shell',
  windowsCmd: false,
  cwd: '/proj/app',
  node: 'v20.11.0',
  git: null,
}

describe('formatEnvironment', () => {
  it('names the shell, the directory and the toolchain', () => {
    const block = formatEnvironment(WINDOWS)
    expect(block).toContain('cmd.exe')
    expect(block).toContain('C:\\proj\\app')
    expect(block).toContain('node v20.11.0')
    expect(block).toContain('git version 2.43.0')
  })

  it('warns cmd users off the unix tools that do not exist there', () => {
    const block = formatEnvironment(WINDOWS)
    for (const missing of ['cat', 'ls', 'grep', 'sed', 'awk', 'rm']) {
      expect(block).toContain(missing)
    }
    // ...and names what to use instead.
    expect(block).toContain('`type <file>`')
    expect(block).toContain('`dir /b`')
    expect(block).toContain('`findstr`')
    expect(block).toContain('`del`')
  })

  it('states that `;` is not a separator and that env vars do not work', () => {
    const block = formatEnvironment(WINDOWS)
    expect(block).toContain('is NOT a command separator')
    expect(block).toContain('set X=1 && cmd')
    expect(block).toContain('prefer a CLI flag')
  })

  it('does not claim the unix tools are missing on a posix host', () => {
    const block = formatEnvironment(POSIX)
    expect(block).not.toContain('These do NOT exist here')
    expect(block).toContain('are available')
    expect(block).toContain('does NOT persist')
  })

  it('says the tail of long output survives, and forbids long-running processes', () => {
    for (const facts of [WINDOWS, POSIX]) {
      const block = formatEnvironment(facts)
      expect(block).toContain('truncated in the MIDDLE')
      expect(block).toContain('read `PASS`/`FAIL` lines')
      expect(block).toContain('Never start an interactive or long-running process')
      expect(block).toContain('A non-zero exit is not proof the program is broken')
    }
  })

  it('reports a missing git rather than implying one', () => {
    expect(formatEnvironment(POSIX)).toContain('git not available')
  })
})

describe('summariseEnvironment', () => {
  it('is one line naming the platform and node version', () => {
    expect(summariseEnvironment(WINDOWS)).toBe('win32/cmd node v20.11.0')
    expect(summariseEnvironment(POSIX)).toBe('linux/posix node v20.11.0')
  })
})

describe('probeEnvironment', () => {
  it('reports the real platform and never throws', () => {
    const facts = probeEnvironment()
    expect(facts.platform).toBe(process.platform)
    expect(facts.shell.length).toBeGreaterThan(0)
    expect(facts.node).toBe(process.version)
    expect(facts.windowsCmd).toBe(process.platform === 'win32')
  })

  it('uses the directory it is given', () => {
    const facts = probeEnvironment('C:\\somewhere\\else')
    expect(facts.cwd).toBe('C:\\somewhere\\else')
  })
})
