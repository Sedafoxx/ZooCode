/**
 * Self-improvement loop (`lib/improve.ts`) — hermetic tests.
 *
 * Every case runs in a real git repository created under `os.tmpdir()` (the same
 * style as `tests/git.test.ts`) and drives `runImprovement` with the scripted
 * mock LLM plus an INJECTED gate runner, so:
 *
 *  - the real improvement loop is NEVER pointed at the ZooCode repository;
 *  - `npm run verify` is never shelled out to from here — the only real commands
 *    that run are `git` (in the temp repo) and `node --version` (for `verifyRepo`);
 *  - nothing touches the network and no API key is required.
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'

import { commit as gitCommit, init, stageAll } from '../lib/git.js'
import {
  runImprovement,
  guardTools,
  verifyRepo,
  defaultImproveSystemPrompt,
  createSteeringLlmClient,
  type VerifyResult,
} from '../lib/improve.js'
import { createMockLlmClient } from '../lib/llm.js'
import { createCoreTools, executeTool } from '../lib/tools.js'
import type { ChatMessage, LlmClient, LlmRequest, ToolDef } from '../lib/types.js'

/* -------------------------------------------------------------------------- */
/* Fixtures + helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Fresh temp dir (no git). */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'zoocode-improve-test-'))
}

/** Fresh temp dir that is a git repo with one commit and a local identity. */
function tempRepo(): string {
  const dir = tempDir()
  init(dir)
  execSync('git config user.name "Zoo Test"', { cwd: dir })
  execSync('git config user.email "zoo@example.com"', { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  stageAll(dir)
  const committed = gitCommit(dir, 'chore: fixture')
  if (!committed.ok) throw new Error(`fixture commit failed: ${committed.error ?? 'unknown'}`)
  return dir
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function currentBranch(dir: string): string {
  return (execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf-8' }) as string).trim()
}

function localBranches(dir: string): string[] {
  // `execFileSync` (no shell) keeps the `%(refname:short)` format string intact
  // on every platform.
  const raw = execFileSync('git', ['branch', '--format=%(refname:short)'], {
    cwd: dir,
    encoding: 'utf-8',
  }) as string
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function porcelain(dir: string): string {
  return (execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' }) as string).trim()
}

/** Porcelain with untracked directories expanded into their files. */
function porcelainAll(dir: string): string {
  return (
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: dir,
      encoding: 'utf-8',
    }) as string
  ).trim()
}

/** An injected gate result: green. */
function greenVerify(command: string): VerifyResult {
  return { ok: true, command, exitCode: 0, tail: 'gate green', durationMs: 5 }
}

/** An injected gate result: red. */
function redVerify(command: string): VerifyResult {
  return {
    ok: false,
    command,
    exitCode: 1,
    tail: 'FAIL tests/thing.test.ts\n1 test failed',
    durationMs: 7,
  }
}

/** A client that records how many times the model was consulted. */
function countingLlm(): { llm: LlmClient; calls: () => number } {
  let calls = 0
  const llm: LlmClient = {
    chat: async () => {
      calls += 1
      return { content: 'noop' }
    },
  }
  return { llm, calls: () => calls }
}

/** Scripted client: write one file, then call `finish`. */
function writeThenFinish(path: string, content = 'hello\n'): LlmClient {
  return createMockLlmClient([
    { content: null, toolCalls: [{ id: 'write-1', name: 'write_file', args: { path, content } }] },
    { content: null, toolCalls: [{ id: 'finish-1', name: 'finish', args: { summary: 'done' } }] },
  ])
}

/** Scripted client: call `finish` immediately, changing nothing. */
function finishOnly(): LlmClient {
  return createMockLlmClient([
    { content: null, toolCalls: [{ id: 'finish-1', name: 'finish', args: { summary: 'done' } }] },
  ])
}

/* -------------------------------------------------------------------------- */
/* (a)–(h) runImprovement                                                     */
/* -------------------------------------------------------------------------- */

describe('runImprovement', () => {
  it('(a) happy path: branches, writes, detects the change, verifies, and does NOT commit', async () => {
    const dir = tempRepo()
    try {
      const base = currentBranch(dir)
      let verifyCalls = 0

      const report = await runImprovement({
        llm: writeThenFinish('lib/new-file.ts', 'export const answer = 42\n'),
        goal: 'add lib/new-file.ts',
        cwd: dir,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => {
          verifyCalls += 1
          return greenVerify(command)
        },
      })

      expect(report.ok).toBe(true)
      expect(report.error).toBeUndefined()
      expect(report.goal).toBe('add lib/new-file.ts')

      // Branch isolation: a fresh branch, checked out, distinct from the base.
      expect(report.branch ?? '').toMatch(/^zoo\/improve-\d{8}-\d{6}$/)
      expect(currentBranch(dir)).toBe(report.branch)
      expect(report.branch).not.toBe(base)
      expect(localBranches(dir)).toContain(report.branch)

      // The agent really wrote the file, and the change is detected.
      expect(existsSync(join(dir, 'lib', 'new-file.ts'))).toBe(true)
      expect(report.changedFiles).toContain('lib/new-file.ts')
      expect(report.diffStat.length).toBeGreaterThan(0)
      expect(report.diffStat).toContain('new-file.ts')

      // The gate ran, with the default command, and nothing was committed.
      expect(verifyCalls).toBe(1)
      expect(report.verify?.ok).toBe(true)
      expect(report.verify?.command).toBe('npm run verify')
      expect(report.committed).toBe(false)
      // Left in the working tree for review — untracked, unstaged, uncommitted.
      expect(porcelainAll(dir)).toContain('?? lib/new-file.ts')
    } finally {
      cleanup(dir)
    }
  })

  it('(b) a red gate forces ok:false even though the agent finished', async () => {
    const dir = tempRepo()
    try {
      const report = await runImprovement({
        llm: writeThenFinish('changed.txt', 'x\n'),
        goal: 'break the gate',
        cwd: dir,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => redVerify(command),
      })

      expect(report.agent?.ok).toBe(true)
      expect(report.verify?.ok).toBe(false)
      expect(report.verify?.exitCode).toBe(1)
      expect(report.ok).toBe(false)
      expect(report.committed).toBe(false)
      expect(report.error ?? '').toContain('Verification failed')
      expect(report.changedFiles).toContain('changed.txt')
    } finally {
      cleanup(dir)
    }
  })

  it('(c) refuses a dirty working tree without touching it', async () => {
    const dir = tempRepo()
    try {
      writeFileSync(join(dir, 'README.md'), '# fixture modified\n')
      const statusBefore = porcelain(dir)
      const branchBefore = currentBranch(dir)
      const { llm, calls } = countingLlm()

      const report = await runImprovement({
        llm,
        goal: 'should not run',
        cwd: dir,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => greenVerify(command),
      })

      expect(report.ok).toBe(false)
      expect(report.preflight.isGitRepo).toBe(true)
      expect(report.preflight.clean).toBe(false)
      expect(report.error ?? '').toContain('not clean')
      expect(report.agent).toBeUndefined()
      expect(report.branch).toBeUndefined()
      expect(report.verify).toBeUndefined()
      expect(calls()).toBe(0)

      // The tree is byte-for-byte where it was: same status, same branch, same file.
      expect(porcelain(dir)).toBe(statusBefore)
      expect(currentBranch(dir)).toBe(branchBefore)
      expect(readFileSync(join(dir, 'README.md'), 'utf-8')).toBe('# fixture modified\n')
    } finally {
      cleanup(dir)
    }
  })

  it('(d) dryRun reports the plan and performs no branch/agent/write', async () => {
    const dir = tempRepo()
    try {
      const branchBefore = currentBranch(dir)
      const { llm, calls } = countingLlm()
      let verifyCalls = 0

      const report = await runImprovement({
        llm,
        goal: 'plan only',
        cwd: dir,
        dryRun: true,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => {
          verifyCalls += 1
          return greenVerify(command)
        },
      })

      expect(report.ok).toBe(true)
      expect(report.branch).toBeUndefined()
      expect(report.agent).toBeUndefined()
      expect(report.verify).toBeUndefined()
      expect(report.committed).toBe(false)
      expect(report.changedFiles).toEqual([])
      expect(report.diffStat).toBe('')

      const notes = report.preflight.notes.join('\n')
      expect(notes).toContain('zoo/improve-')
      expect(notes).toContain('dry run')

      expect(calls()).toBe(0)
      expect(verifyCalls).toBe(0)
      expect(currentBranch(dir)).toBe(branchBefore)
      expect(localBranches(dir)).toEqual([branchBefore])
      expect(porcelain(dir)).toBe('')
    } finally {
      cleanup(dir)
    }
  })

  it('(f) stops at maxSteps and still produces a full report', async () => {
    const dir = tempRepo()
    try {
      let calls = 0
      const llm: LlmClient = {
        chat: async () => {
          calls += 1
          return {
            content: null,
            toolCalls: [{ id: `call-${calls}`, name: 'list_files', args: { path: '.' } }],
          }
        },
      }

      const report = await runImprovement({
        llm,
        goal: 'loop forever',
        cwd: dir,
        maxSteps: 2,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => greenVerify(command),
      })

      expect(calls).toBe(2)
      expect(report.agent?.steps).toBe(2)
      expect(report.agent?.ok).toBe(false)
      expect(report.agent?.error ?? '').toContain('Max steps')
      expect(report.ok).toBe(false)
      expect(report.error ?? '').toContain('did not finish')
      // Bounded work still reports what happened, including the gate result.
      expect(report.verify?.ok).toBe(true)
      expect(report.changedFiles).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  it('(g) refuses a directory that is not a git repository', async () => {
    const dir = tempDir()
    try {
      const { llm, calls } = countingLlm()
      const report = await runImprovement({ llm, goal: 'x', cwd: dir })

      expect(report.ok).toBe(false)
      expect(report.preflight.isGitRepo).toBe(false)
      expect(report.preflight.clean).toBe(false)
      expect(report.error ?? '').toContain('not a git repository')
      expect(report.branch).toBeUndefined()
      expect(report.agent).toBeUndefined()
      expect(report.verify).toBeUndefined()
      expect(calls()).toBe(0)
    } finally {
      cleanup(dir)
    }
  })

  it('(h) a throwing llm.chat never escapes as a rejection', async () => {
    const dir = tempRepo()
    try {
      const llm: LlmClient = {
        chat: async () => {
          throw new Error('model exploded')
        },
      }

      const promise = runImprovement({
        llm,
        goal: 'explode',
        cwd: dir,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => greenVerify(command),
      })
      await expect(promise).resolves.toBeDefined()

      const report = await promise
      expect(report.ok).toBe(false)
      expect(report.agent?.ok).toBe(false)
      expect(report.agent?.error).toBe('model exploded')
      expect(report.error ?? '').toContain('did not finish')
    } finally {
      cleanup(dir)
    }
  })

  it('commits only when asked, with a conventional message', async () => {
    const dir = tempRepo()
    try {
      const report = await runImprovement({
        llm: writeThenFinish('improved.txt'),
        goal: 'add improved.txt to the fixture',
        cwd: dir,
        commit: true,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => greenVerify(command),
      })

      expect(report.ok).toBe(true)
      expect(report.committed).toBe(true)
      expect(porcelain(dir)).toBe('')
      const subject = (
        execSync('git log -1 --pretty=%s', { cwd: dir, encoding: 'utf-8' }) as string
      ).trim()
      expect(subject).toBe('chore(improve): add improved.txt to the fixture')
    } finally {
      cleanup(dir)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* (e) guardTools                                                             */
/* -------------------------------------------------------------------------- */

describe('guardTools', () => {
  /** One refused write, with nothing left on disk. */
  async function expectRefused(
    tools: ToolDef[],
    root: string,
    path: string,
    forbidden: string,
    content = 'payload',
  ): Promise<string> {
    const result = await executeTool(tools, 'write_file', { path, content }, { cwd: root })
    expect(result.ok).toBe(false)
    expect(result.error ?? '').toMatch(/^Refused: /)
    expect(result.error ?? '').toContain(forbidden)
    expect(result.content).toBe(path)
    return result.error ?? ''
  }

  it('(e) refuses writes outside the root and to protected paths, writing nothing', async () => {
    const dir = tempRepo()
    try {
      const tools = guardTools(createCoreTools(), dir)

      const escaped = join(dirname(dir), `${basename(dir)}-escaped.txt`)
      const traversed = join(dirname(dir), `${basename(dir)}-traversal.txt`)

      await expectRefused(tools, dir, escaped, 'outside the repository root')
      await expectRefused(tools, dir, join('..', `${basename(dir)}-traversal.txt`), 'outside the repository root')
      await expectRefused(tools, dir, '.env', 'environment file')
      await expectRefused(tools, dir, '.env.local', 'environment file')
      await expectRefused(tools, dir, join('.git', 'config'), '.git/')
      await expectRefused(tools, dir, join('node_modules', 'pkg', 'index.js'), 'node_modules/')
      await expectRefused(tools, dir, join('.claude', 'settings.json'), '.claude/')
      await expectRefused(tools, dir, join('.zoo', 'usage.jsonl'), 'usage ledger')

      // Nothing was created, anywhere — including outside the root.
      expect(existsSync(escaped)).toBe(false)
      expect(existsSync(traversed)).toBe(false)
      expect(existsSync(join(dir, '.env'))).toBe(false)
      expect(existsSync(join(dir, '.env.local'))).toBe(false)
      expect(existsSync(join(dir, '.zoo'))).toBe(false)
      expect(porcelain(dir)).toBe('')

      // The real .git/config is untouched.
      expect(readFileSync(join(dir, '.git', 'config'), 'utf-8')).toContain('[core]')
    } finally {
      cleanup(dir)
    }
  })

  it('(e) allows a write inside the root (positive control)', async () => {
    const dir = tempRepo()
    try {
      const tools = guardTools(createCoreTools(), dir)
      const result = await executeTool(
        tools,
        'write_file',
        { path: 'lib/ok.ts', content: 'export const ok = true\n' },
        { cwd: dir },
      )
      expect(result.ok).toBe(true)
      expect(existsSync(join(dir, 'lib', 'ok.ts'))).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('refuses a run_command whose cwd is outside the root', async () => {
    const dir = tempRepo()
    try {
      const tools = guardTools(createCoreTools(), dir)
      const result = await executeTool(
        tools,
        'run_command',
        { command: 'node --version', cwd: dirname(dir) },
        { cwd: dir },
      )
      expect(result.ok).toBe(false)
      expect(result.error ?? '').toMatch(/^Refused: /)
      expect(result.error ?? '').toContain('outside the repository root')
    } finally {
      cleanup(dir)
    }
  })

  it('preserves the tool list and leaves non-mutating tools working', async () => {
    const dir = tempRepo()
    try {
      const tools = guardTools(createCoreTools(), dir)
      expect(tools.map((tool) => tool.name)).toEqual(createCoreTools().map((tool) => tool.name))

      const read = await executeTool(tools, 'read_file', { path: 'README.md' }, { cwd: dir })
      expect(read.ok).toBe(true)
      expect(read.content).toContain('# fixture')
    } finally {
      cleanup(dir)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* verifyRepo                                                                 */
/* -------------------------------------------------------------------------- */

describe('verifyRepo', () => {
  it('runs the command in cwd and captures a green result', async () => {
    const dir = tempDir()
    try {
      const result = await verifyRepo(dir, 'node --version')
      expect(result.ok).toBe(true)
      expect(result.exitCode).toBe(0)
      expect(result.command).toBe('node --version')
      expect(result.tail).toMatch(/v\d+\./)
      expect(typeof result.durationMs).toBe('number')
    } finally {
      cleanup(dir)
    }
  })

  it('reports a red result for a failing command without throwing', async () => {
    const dir = tempDir()
    try {
      const result = await verifyRepo(dir, 'node -e "process.exit(3)"')
      expect(result.ok).toBe(false)
      expect(result.exitCode).toBe(3)
    } finally {
      cleanup(dir)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* defaultImproveSystemPrompt                                                 */
/* -------------------------------------------------------------------------- */

describe('defaultImproveSystemPrompt', () => {
  it('(a) is action-forcing and still contains the goal verbatim', () => {
    const goal = 'add a --version flag to the CLI'
    const prompt = defaultImproveSystemPrompt(goal)

    expect(prompt).toContain(`Goal: ${goal}`)
    expect(prompt).toContain(goal)

    // Action-forcing directives (Deliverable 1).
    expect(prompt).toMatch(/act, do not deliberate/i)
    expect(prompt).toMatch(/do NOT write plans/i)
    expect(prompt).toMatch(/do not survey the repository/i)
    expect(prompt).toMatch(/within your FIRST THREE tool calls/i)
    expect(prompt).toMatch(/prefer editing an existing file/i)
    expect(prompt).toMatch(/only AFTER the change has been written/i)
    expect(prompt).toMatch(/call the `finish` tool as soon as the goal is met/i)

    // The rails are still stated.
    expect(prompt).toContain('npm run verify')
    expect(prompt).toContain('Never create branches, commit, push, or reset')
    expect(prompt).toContain('allowlist')
  })
})

/* -------------------------------------------------------------------------- */
/* createSteeringLlmClient                                                    */
/* -------------------------------------------------------------------------- */

/** Drive a steering-wrapped client for `steps` chats; return what was sent. */
async function driveSteering(
  maxSteps: number | undefined,
  steps: number,
  options?: { nudgeAt?: number; warnAt?: number; reserve?: number },
): Promise<{ requests: LlmRequest[]; injected: () => number; base: ChatMessage[] }> {
  const requests: LlmRequest[] = []
  const inner: LlmClient = {
    chat: async (req) => {
      requests.push(req)
      return { content: 'noop' }
    },
  }
  const steering = createSteeringLlmClient(inner, { maxSteps, ...options })
  const base: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'goal' },
  ]
  for (let i = 0; i < steps; i++) {
    await steering.client.chat({ model: 'mock', messages: base })
  }
  return { requests, injected: steering.injected, base }
}

/** The steering reminder the decorator appended to a request, if any. */
function steeringOf(req: LlmRequest): string | undefined {
  const last = req.messages[req.messages.length - 1]
  if (last?.role === 'user' && typeof last.content === 'string' && /^Step \d+ of \d+:/.test(last.content)) {
    return last.content
  }
  return undefined
}

describe('createSteeringLlmClient', () => {
  it('(b) nudges at 60% and warns hard at 85% of the budget', async () => {
    const { requests, injected } = await driveSteering(10, 10)

    // Steps 1-5 untouched; step 6 nudges; steps 7-8 stay quiet; step 9 warns.
    expect(steeringOf(requests[4])).toBeUndefined()
    const nudge = steeringOf(requests[5])
    expect(nudge).toBeDefined()
    expect(nudge ?? '').toContain('Step 6 of 10')
    expect(nudge ?? '').toContain('WRITE the change now')
    expect(steeringOf(requests[6])).toBeUndefined()
    expect(steeringOf(requests[7])).toBeUndefined()
    const warn = steeringOf(requests[8])
    expect(warn).toBeDefined()
    expect(warn ?? '').toContain('Step 9 of 10')
    expect(warn ?? '').toContain('only 1 step remaining')
    expect(warn ?? '').toContain('`finish`')
    expect(steeringOf(requests[9])).toBeUndefined()

    expect(injected()).toBe(2)
  })

  it('(c) injects each tier at most once and at most one message per step', async () => {
    const { requests, injected } = await driveSteering(10, 12)

    const added = requests.map((req) => req.messages.length - 2)
    expect(added.every((extra) => extra >= 0 && extra <= 1)).toBe(true)

    const reminders = requests
      .map(steeringOf)
      .filter((content): content is string => content !== undefined)
    expect(reminders).toHaveLength(2)
    expect(reminders.filter((content) => content.includes('Stop exploring'))).toHaveLength(1)
    expect(reminders.filter((content) => content.includes('IMMEDIATELY'))).toHaveLength(1)
    expect(injected()).toBe(2)
  })

  it('(c1) reserves the last steps for verification when asked', async () => {
    // maxSteps 10 with reserve 4: step 6 would have been the ordinary nudge, but
    // the reserve tier outranks it and is the only reminder injected, so the run
    // is not nagged back into investigating.
    const { requests, injected } = await driveSteering(10, 10, { reserve: 4 })

    expect(steeringOf(requests[4])).toBeUndefined()
    const reserved = steeringOf(requests[5])
    expect(reserved).toBeDefined()
    expect(reserved ?? '').toContain('Step 6 of 10')
    expect(reserved ?? '').toContain('RESERVED for verification')
    expect(reserved ?? '').toContain('start nothing new')
    expect(reserved ?? '').toContain('Do not claim success you have not measured')
    expect(steeringOf(requests[6])).toBeUndefined()
    expect(steeringOf(requests[8])).toBeUndefined()
    expect(injected()).toBe(1)
  })

  it('(c2) never reserves more steps than the budget has', async () => {
    const { requests } = await driveSteering(10, 10, { reserve: 50 })
    expect(steeringOf(requests[0]) ?? '').toContain('last 9 are RESERVED')
  })

  it('(c3) is inert without a budget to reserve from', async () => {
    const { requests, injected } = await driveSteering(undefined, 20, { reserve: 4 })
    expect(requests.every((req) => steeringOf(req) === undefined)).toBe(true)
    expect(injected()).toBe(0)
  })

  it('(d) is inert when maxSteps is undefined or <= 0', async () => {
    for (const maxSteps of [undefined, 0, -3]) {
      const { requests, injected } = await driveSteering(maxSteps, 12)
      expect(requests.every((req) => req.messages.length === 2)).toBe(true)
      expect(injected()).toBe(0)
    }
  })

  it("(e) never mutates the caller's array or its message objects", async () => {
    const { requests, base } = await driveSteering(10, 10)
    const snapshot = JSON.parse(JSON.stringify(base)) as ChatMessage[]

    // The caller's array still holds exactly the two original messages...
    expect(base).toEqual(snapshot)
    expect(base).toHaveLength(2)
    // ...and is never the same array handed to the inner client on a steered step.
    expect(requests[5].messages).not.toBe(base)
    // The appended reminder is new; the original message objects keep identity.
    expect(requests[5].messages[0]).toBe(base[0])
    expect(requests[5].messages[1]).toBe(base[1])
  })
})

/* -------------------------------------------------------------------------- */
/* Steering + artifacts inside runImprovement                                 */
/* -------------------------------------------------------------------------- */

describe('runImprovement steering', () => {
  it('(b) injects reminders, records them, and never leaks them into the transcript', async () => {
    const dir = tempRepo()
    try {
      const seen: LlmRequest[] = []
      let calls = 0
      const llm: LlmClient = {
        chat: async (req) => {
          seen.push(req)
          calls += 1
          return {
            content: null,
            toolCalls: [{ id: `call-${calls}`, name: 'list_files', args: { path: '.' } }],
          }
        },
      }

      const report = await runImprovement({
        llm,
        goal: 'never finish',
        cwd: dir,
        maxSteps: 10,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => greenVerify(command),
      })

      expect(report.agent?.steps).toBe(10)
      expect(report.steeringInjected).toBe(2)

      const steered = seen.filter((req) =>
        req.messages.some(
          (message) => message.role === 'user' && /^Step \d+ of 10:/.test(message.content ?? ''),
        ),
      )
      expect(steered).toHaveLength(2)
      expect(steered[0].messages[steered[0].messages.length - 1].content).toContain('Step 6 of 10')
      expect(steered[1].messages[steered[1].messages.length - 1].content).toContain('Step 9 of 10')

      // The outbound reminders must NOT have corrupted the loop's own transcript.
      const leaked = (report.agent?.messages ?? []).some(
        (message) =>
          typeof message.content === 'string' && message.content.includes('Step 6 of 10'),
      )
      expect(leaked).toBe(false)
    } finally {
      cleanup(dir)
    }
  })
})

describe('runImprovement artifacts', () => {
  it('(f) writes changed.patch (including untracked files) and report.json', async () => {
    const dir = tempRepo()
    try {
      const report = await runImprovement({
        llm: writeThenFinish('lib/new-file.ts', 'export const answer = 42\n'),
        goal: 'add lib/new-file.ts',
        cwd: dir,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => greenVerify(command),
      })

      expect(report.ok).toBe(true)
      expect(report.artifactsDir).toBeDefined()
      const artifactsDir = report.artifactsDir as string
      expect(artifactsDir).toContain(join('.zoo', 'improve'))

      const patch = readFileSync(join(artifactsDir, 'changed.patch'), 'utf-8')
      expect(patch).toContain('lib/new-file.ts')
      expect(patch).toContain('+export const answer = 42')

      const parsed = JSON.parse(readFileSync(join(artifactsDir, 'report.json'), 'utf-8')) as {
        ok: boolean
        goal: string
        artifactsDir?: string
        steeringInjected?: number
      }
      expect(parsed.ok).toBe(true)
      expect(parsed.goal).toBe('add lib/new-file.ts')
      expect(parsed.artifactsDir).toBe(artifactsDir)
      expect(parsed.steeringInjected).toBe(0)
    } finally {
      cleanup(dir)
    }
  })

  it('(g) preserves partial progress when the run FAILS by step exhaustion', async () => {
    const dir = tempRepo()
    try {
      let calls = 0
      const llm: LlmClient = {
        chat: async () => {
          calls += 1
          if (calls === 1) {
            return {
              content: null,
              toolCalls: [
                {
                  id: 'write-1',
                  name: 'write_file',
                  args: { path: 'partial.ts', content: 'export const partial = true\n' },
                },
              ],
            }
          }
          return {
            content: null,
            toolCalls: [{ id: `call-${calls}`, name: 'list_files', args: { path: '.' } }],
          }
        },
      }

      const report = await runImprovement({
        llm,
        goal: 'never finish',
        cwd: dir,
        maxSteps: 3,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => greenVerify(command),
      })

      expect(report.agent?.ok).toBe(false)
      expect(report.agent?.error ?? '').toContain('Max steps')
      expect(report.ok).toBe(false)
      expect(report.artifactsDir).toBeDefined()

      const patch = readFileSync(join(report.artifactsDir as string, 'changed.patch'), 'utf-8')
      expect(patch).toContain('partial.ts')
      expect(patch).toContain('+export const partial = true')
    } finally {
      cleanup(dir)
    }
  })

  it('(h) leaves the repo clean: artifacts are ignored and nothing is left staged', async () => {
    const dir = tempRepo()
    try {
      const report = await runImprovement({
        llm: finishOnly(),
        goal: 'no-op',
        cwd: dir,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => greenVerify(command),
      })

      expect(report.ok).toBe(true)
      expect(report.artifactsDir).toBeDefined()
      expect(existsSync(join(report.artifactsDir as string, 'changed.patch'))).toBe(true)

      // The artifacts exist on disk yet the tree reports CLEAN — proof they are
      // ignored — and nothing is staged.
      expect(porcelainAll(dir)).toBe('')
      expect(porcelain(dir)).toBe('')
      const staged = (
        execSync('git diff --cached --name-only', { cwd: dir, encoding: 'utf-8' }) as string
      ).trim()
      expect(staged).toBe('')
    } finally {
      cleanup(dir)
    }
  })

  it('(i) an artifacts-write failure does not change ok', async () => {
    const dir = tempRepo()
    try {
      // Obstruct the artifact path with a committed FILE named `.zoo/improve` so
      // the mkdir/write under it fails while the tree stays clean.
      mkdirSync(join(dir, '.zoo'), { recursive: true })
      writeFileSync(join(dir, '.zoo', 'improve'), 'obstruction\n')
      stageAll(dir)
      const committed = gitCommit(dir, 'chore: obstruct the artifacts path')
      expect(committed.ok).toBe(true)

      const report = await runImprovement({
        llm: writeThenFinish('ok.txt'),
        goal: 'still succeeds',
        cwd: dir,
        runVerify: async (_cwd: string, command: string): Promise<VerifyResult> => greenVerify(command),
      })

      expect(report.ok).toBe(true)
      expect(report.artifactsDir).toBeUndefined()
      expect(report.preflight.notes.join('\n')).toMatch(/could not write improve artifacts/i)
    } finally {
      cleanup(dir)
    }
  })
})
