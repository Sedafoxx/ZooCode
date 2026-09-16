/**
 * Fixtures exist to make the expensive part of an iteration loop free. The tests
 * therefore care most about the SAFETY property: in replay mode a command must not
 * execute, and a command with no recording must fail loudly rather than quietly
 * producing nothing. A replay that lied would be worse than no replay, because an
 * agent would believe it had verified something it had not.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createFixtureStore, fixtureKey, formatFixtureNotice } from '../lib/fixtures.js'
import { createExecPolicy } from '../lib/policy.js'
import { createCoreTools, executeTool } from '../lib/tools.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'zoo-fixtures-'))
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/** Tools wired to a fixture store, so `run_command` goes through the seam. */
function toolsFor(dir: string, mode: 'record' | 'replay', policyMode: 'allow' | 'allowlist' = 'allow') {
  const store = createFixtureStore({ mode, file: join(dir, '.zoo', 'fixtures.json') })
  const tools = createCoreTools({
    policy: createExecPolicy({ mode: policyMode }),
    fixtures: store,
  })
  return { store, tools }
}

describe('fixtureKey', () => {
  it('normalises whitespace so a re-typed command still matches', () => {
    expect(fixtureKey('  npm   run   test ')).toBe('npm run test')
    expect(fixtureKey('npm run test')).toBe('npm run test')
    expect(fixtureKey('npm\nrun\ttest')).toBe('npm run test')
  })
})

describe('createFixtureStore', () => {
  it('records, persists, and reads back through a fresh store', () => {
    const dir = tempDir()
    try {
      const file = join(dir, '.zoo', 'fixtures.json')
      const first = createFixtureStore({ mode: 'record', file })
      first.record({ command: 'npm run check', ok: true, exitCode: 0, content: 'all good' })
      expect(existsSync(file)).toBe(true)

      const second = createFixtureStore({ mode: 'replay', file })
      const hit = second.lookup('npm  run   check')
      expect(hit?.content).toBe('all good')
      expect(hit?.ok).toBe(true)
      expect(second.stats().hits).toBe(1)
    } finally {
      cleanup(dir)
    }
  })

  it('counts a replay miss instead of throwing', () => {
    const dir = tempDir()
    try {
      const store = createFixtureStore({ mode: 'replay', file: join(dir, '.zoo', 'fixtures.json') })
      expect(store.lookup('never recorded')).toBeUndefined()
      expect(store.stats().misses).toBe(1)
    } finally {
      cleanup(dir)
    }
  })

  it('treats a corrupt store as empty rather than failing the run', () => {
    const dir = tempDir()
    try {
      const file = join(dir, '.zoo', 'fixtures.json')
      const store = createFixtureStore({ mode: 'record', file })
      store.flush()
      writeFileSync(file, '{ this is not json', 'utf-8')

      const reopened = createFixtureStore({ mode: 'replay', file })
      expect(reopened.lookup('anything')).toBeUndefined()
      expect(reopened.stats().total).toBe(0)
    } finally {
      cleanup(dir)
    }
  })

  it('writes the store immediately, so a step-capped run keeps what it paid for', () => {
    const dir = tempDir()
    try {
      const file = join(dir, '.zoo', 'fixtures.json')
      const store = createFixtureStore({ mode: 'record', file })
      store.record({ command: 'slow check', ok: true, exitCode: 0, content: 'expensive output' })
      // No flush() call: the record itself must have hit the disk.
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
        entries: Record<string, { content: string }>
      }
      expect(Object.values(parsed.entries)[0]?.content).toBe('expensive output')
    } finally {
      cleanup(dir)
    }
  })
})

describe('run_command under fixtures', () => {
  it('records a real execution, and replays it without running anything', async () => {
    const dir = tempDir()
    try {
      const record = toolsFor(dir, 'record')
      const ran = await executeTool(record.tools, 'run_command', { command: 'echo hello' }, { cwd: dir })
      expect(ran.ok).toBe(true)
      expect(ran.content).toContain('hello')
      expect(record.store.stats().recorded).toBe(1)

      // Now RE-WRITE the recording with output the command could not possibly
      // produce. If replay still executed, the assertion below would see "hello".
      const file = join(dir, '.zoo', 'fixtures.json')
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
        entries: Record<string, { content: string }>
      }
      for (const entry of Object.values(parsed.entries)) entry.content = 'FROM-THE-STORE-NOT-THE-SHELL'
      writeFileSync(file, JSON.stringify(parsed), 'utf-8')

      const replay = toolsFor(dir, 'replay')
      const replayed = await executeTool(replay.tools, 'run_command', { command: 'echo hello' }, { cwd: dir })
      expect(replayed.ok).toBe(true)
      expect(replayed.content).toBe('FROM-THE-STORE-NOT-THE-SHELL')
      expect(replay.store.stats().hits).toBe(1)
    } finally {
      cleanup(dir)
    }
  })

  it('fails loudly on a replay miss for a command that WOULD have worked', async () => {
    const dir = tempDir()
    try {
      const replay = toolsFor(dir, 'replay')
      // `echo` would plainly succeed if it were executed. The point is that it is not.
      const result = await executeTool(replay.tools, 'run_command', { command: 'echo should-not-run' }, { cwd: dir })
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Replay miss')
      expect(result.content).toContain('Replay miss')
      expect(result.content).toContain('did NOT run')
      expect(result.content).not.toContain('should-not-run\n')
      expect(replay.store.stats().misses).toBe(1)
    } finally {
      cleanup(dir)
    }
  })

  it('reproduces a recorded failure faithfully', async () => {
    const dir = tempDir()
    try {
      const record = toolsFor(dir, 'record')
      const failed = await executeTool(
        record.tools,
        'run_command',
        { command: 'node -e "process.exit(3)"' },
        { cwd: dir },
      )
      expect(failed.ok).toBe(false)

      const file = join(dir, '.zoo', 'fixtures.json')
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
        entries: Record<string, { exitCode: number; ok: boolean }>
      }
      expect(Object.values(parsed.entries)[0]?.exitCode).toBe(3)
      expect(Object.values(parsed.entries)[0]?.ok).toBe(false)

      const replay = toolsFor(dir, 'replay')
      const replayed = await executeTool(
        replay.tools,
        'run_command',
        { command: 'node -e "process.exit(3)"' },
        { cwd: dir },
      )
      expect(replayed.ok).toBe(false)
    } finally {
      cleanup(dir)
    }
  })

  it('still applies the policy gate before a replay is served', async () => {
    const dir = tempDir()
    try {
      // Nothing is recorded, and the command is not on the allowlist: the refusal
      // must be the policy's, not a replay miss. A command that is refused can
      // never become allowed merely because the shell is simulated.
      const store = createFixtureStore({ mode: 'replay', file: join(dir, '.zoo', 'fixtures.json') })
      const tools = createCoreTools({
        policy: createExecPolicy({ mode: 'allowlist' }),
        fixtures: store,
      })
      const result = await executeTool(tools, 'run_command', { command: 'curl http://example.com' }, { cwd: dir })
      expect(result.ok).toBe(false)
      expect(result.error ?? '').toContain('refused by policy')
      expect(store.stats().misses).toBe(0)
    } finally {
      cleanup(dir)
    }
  })

  it('executes normally when no store is configured', async () => {
    const dir = tempDir()
    try {
      const tools = createCoreTools({ policy: createExecPolicy({ mode: 'allow' }) })
      const result = await executeTool(tools, 'run_command', { command: 'echo plain' }, { cwd: dir })
      expect(result.ok).toBe(true)
      expect(result.content).toContain('plain')
    } finally {
      cleanup(dir)
    }
  })
})

describe('formatFixtureNotice', () => {
  it('says nothing when fixtures are off', () => {
    expect(formatFixtureNotice('off', 'x.json')).toBe('')
  })

  it('tells the model the shell is simulated, so a miss is not "fixed"', () => {
    const notice = formatFixtureNotice('replay', '.zoo/fixtures.json')
    expect(notice).toContain('REPLAYING')
    expect(notice).toContain('does NOT execute')
    expect(notice).toContain('Replay miss')
    expect(notice).toContain('never invent the output')
  })

  it('tells the model what recording is for when recording', () => {
    const notice = formatFixtureNotice('record', '.zoo/fixtures.json')
    expect(notice).toContain('RECORDING')
    expect(notice).toContain('slow check you are iterating on')
  })
})
