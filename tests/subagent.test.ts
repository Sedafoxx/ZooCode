import { describe, it, expect } from 'vitest'
import { DEFAULT_CONCURRENCY, runParallel, toolsForTask } from '../lib/subagent.js'
import type { RunParallelOptions } from '../lib/subagent.js'
import { createMockLlmClient } from '../lib/llm.js'
import type { AgentEvent, ChatMessage, LlmClient, LlmRequest, SubTask, ToolDef } from '../lib/types.js'

/* -------------------------------------------------------------------------- */
/* Fixtures + instrumentation                                                 */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Text of the last `user` message — our stand-in for "which task is this?". */
function lastUserContent(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user') return message.content ?? ''
  }
  return ''
}

/** Concurrency instrumentation filled in by `probeLlm`. */
interface Probe {
  calls: number
  inFlight: number
  maxInFlight: number
  /** Prompts in the order their first LLM response resolved. */
  completed: string[]
  /** First transcript seen per prompt, so tests can assert what we sent. */
  seen: Record<string, ChatMessage[]>
}

interface ProbeOptions {
  /** Per-prompt artificial latency, which is what makes overlap observable. */
  delays?: Record<string, number>
  /** Prompts whose llm call should reject, to exercise failure isolation. */
  fail?: string[]
}

/**
 * Instrumented mock llm (function form of `createMockLlmClient`).
 *
 * It counts how many `chat` calls are in flight at once and records the peak, so
 * a test can prove the worker pool actually overlaps work (and that it never
 * exceeds the requested concurrency).
 */
function probeLlm(options: ProbeOptions = {}): { llm: LlmClient; probe: Probe } {
  const delays = options.delays ?? {}
  const fail = new Set(options.fail ?? [])
  const probe: Probe = { calls: 0, inFlight: 0, maxInFlight: 0, completed: [], seen: {} }

  const llm = createMockLlmClient(async (req: LlmRequest) => {
    const key = lastUserContent(req.messages)
    if (probe.seen[key] === undefined) probe.seen[key] = req.messages

    probe.calls += 1
    probe.inFlight += 1
    probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight)

    try {
      const wait = delays[key] ?? 0
      if (wait > 0) await delay(wait)
      if (fail.has(key)) throw new Error(`boom:${key}`)
      probe.completed.push(key)
      return { content: `final:${key}` }
    } finally {
      probe.inFlight -= 1
    }
  })

  return { llm, probe }
}

function task(id: string, prompt: string, system?: string, tools?: string[]): SubTask {
  const subTask: SubTask = { id, prompt }
  if (system !== undefined) subTask.system = system
  if (tools !== undefined) subTask.tools = tools
  return subTask
}

function fakeTool(name: string): ToolDef {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ ok: true, content: `${name}:done` }),
  }
}

function baseOptions(llm: LlmClient, overrides: Partial<RunParallelOptions> = {}): RunParallelOptions {
  return { llm, tools: [fakeTool('alpha')], concurrency: 3, ...overrides }
}

/* -------------------------------------------------------------------------- */
/* (a) happy path + ordering by input                                         */
/* -------------------------------------------------------------------------- */

describe('runParallel — basic fan-out', () => {
  it('runs 3 tasks at concurrency 3 and reports ok with results in input order', async () => {
    const { llm, probe } = probeLlm()
    const tasks = [task('t1', 't1'), task('t2', 't2'), task('t3', 't3')]

    const outcome = await runParallel(tasks, baseOptions(llm, { concurrency: 3 }))

    expect(outcome.ok).toBe(true)
    expect(outcome.error).toBeUndefined()
    expect(outcome.results.map((entry) => entry.id)).toEqual(['t1', 't2', 't3'])
    for (const entry of outcome.results) {
      expect(entry.ok).toBe(true)
      expect(entry.final).toBe(`final:${entry.id}`)
      expect(entry.steps).toBe(1)
      expect(entry.error).toBeUndefined()
    }
    expect(probe.calls).toBe(3)
  })

  it('preserves each task transcript in isolation (no shared conversation)', async () => {
    const { llm } = probeLlm()
    const tasks = [task('t1', 'prompt-one'), task('t2', 'prompt-two')]

    const outcome = await runParallel(tasks, baseOptions(llm))

    expect(outcome.results[0].result.messages[0]).toEqual({ role: 'user', content: 'prompt-one' })
    expect(outcome.results[1].result.messages[0]).toEqual({ role: 'user', content: 'prompt-two' })
    expect(outcome.results[0].result.messages).not.toBe(outcome.results[1].result.messages)
  })

  it('defaults the concurrency to 3 when the option is omitted', () => {
    expect(DEFAULT_CONCURRENCY).toBe(3)
  })
})

/* -------------------------------------------------------------------------- */
/* (b) completion order must not leak into result order                       */
/* -------------------------------------------------------------------------- */

describe('runParallel — result ordering', () => {
  it('keeps input order even when the last task finishes first', async () => {
    const { llm, probe } = probeLlm({ delays: { t1: 100, t2: 40, t3: 5 } })
    const tasks = [task('t1', 't1'), task('t2', 't2'), task('t3', 't3')]

    const outcome = await runParallel(tasks, baseOptions(llm, { concurrency: 3 }))

    // Completion order: fastest first (t3), slowest last (t1).
    expect(probe.completed).toEqual(['t3', 't2', 't1'])
    // Result order: still the input order.
    expect(outcome.results.map((entry) => entry.id)).toEqual(['t1', 't2', 't3'])
    expect(outcome.results[0].final).toBe('final:t1')
    expect(outcome.results[2].final).toBe('final:t3')
    expect(outcome.ok).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* (c)+(d) concurrency proof                                                  */
/* -------------------------------------------------------------------------- */

describe('runParallel — concurrency ceiling and real overlap', () => {
  it('never exceeds a concurrency of 1 (max in-flight is exactly 1)', async () => {
    const { llm, probe } = probeLlm({ delays: { t1: 20, t2: 20, t3: 20 } })
    const tasks = [task('t1', 't1'), task('t2', 't2'), task('t3', 't3')]

    const outcome = await runParallel(tasks, baseOptions(llm, { concurrency: 1 }))

    expect(outcome.ok).toBe(true)
    expect(probe.maxInFlight).toBe(1)
    expect(probe.calls).toBe(3)
  })

  it('normalizes a concurrency of 0 to 1 instead of deadlocking', async () => {
    const { llm, probe } = probeLlm({ delays: { t1: 10, t2: 10 } })
    const tasks = [task('t1', 't1'), task('t2', 't2')]

    const outcome = await runParallel(tasks, baseOptions(llm, { concurrency: 0 }))

    expect(outcome.ok).toBe(true)
    expect(probe.maxInFlight).toBe(1)
  })

  it('actually overlaps tasks when concurrency is 3 (max in-flight >= 2)', async () => {
    const { llm, probe } = probeLlm({ delays: { t1: 30, t2: 30, t3: 30 } })
    const tasks = [task('t1', 't1'), task('t2', 't2'), task('t3', 't3')]

    const outcome = await runParallel(tasks, baseOptions(llm, { concurrency: 3 }))

    expect(probe.maxInFlight).toBeGreaterThanOrEqual(2)
    expect(probe.maxInFlight).toBeLessThanOrEqual(3)
    expect(outcome.results.every((entry) => entry.ok)).toBe(true)
  })

  it('caps the pool at the requested concurrency with more tasks than slots', async () => {
    const { llm, probe } = probeLlm({ delays: { t1: 15, t2: 15, t3: 15, t4: 15, t5: 15 } })
    const tasks = [1, 2, 3, 4, 5].map((n) => task(`t${n}`, `t${n}`))

    const outcome = await runParallel(tasks, baseOptions(llm, { concurrency: 2 }))

    expect(probe.maxInFlight).toBeLessThanOrEqual(2)
    expect(probe.maxInFlight).toBeGreaterThanOrEqual(2)
    expect(outcome.results.map((entry) => entry.id)).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })
})

/* -------------------------------------------------------------------------- */
/* (e) failure isolation                                                      */
/* -------------------------------------------------------------------------- */

describe('runParallel — failure isolation', () => {
  it('isolates a failing task and still completes the others', async () => {
    const { llm, probe } = probeLlm({ fail: ['bad'] })
    const tasks = [task('ok1', 'ok1'), task('bad', 'bad'), task('ok2', 'ok2')]

    const outcome = await runParallel(tasks, baseOptions(llm, { concurrency: 3 }))

    expect(outcome.ok).toBe(false)
    expect(outcome.results.map((entry) => entry.id)).toEqual(['ok1', 'bad', 'ok2'])
    expect(outcome.results[0].ok).toBe(true)
    expect(outcome.results[1].ok).toBe(false)
    expect(outcome.results[1].error).toContain('boom:bad')
    expect(outcome.results[1].result.ok).toBe(false)
    expect(outcome.results[2].ok).toBe(true)
    expect(probe.calls).toBe(3)
  })

  it('never rejects when every task fails', async () => {
    const { llm } = probeLlm({ fail: ['a', 'b'] })
    const tasks = [task('a', 'a'), task('b', 'b')]

    const outcome = await runParallel(tasks, baseOptions(llm))

    expect(outcome.ok).toBe(false)
    expect(outcome.results).toHaveLength(2)
    expect(outcome.results.every((entry) => !entry.ok && entry.error !== undefined)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* (f) tool scoping                                                           */
/* -------------------------------------------------------------------------- */

describe('toolsForTask', () => {
  const tools = [fakeTool('alpha'), fakeTool('beta'), fakeTool('gamma')]

  it('returns all tools when the task omits the tools list', () => {
    const scoped = toolsForTask(tools, { id: 'x', prompt: 'p' })
    expect(scoped.map((tool) => tool.name)).toEqual(['alpha', 'beta', 'gamma'])
    expect(scoped).not.toBe(tools)
  })

  it('returns all tools when the tools list is empty', () => {
    const scoped = toolsForTask(tools, { id: 'x', prompt: 'p', tools: [] })
    expect(scoped.map((tool) => tool.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('returns only the requested names in request order, dropping unknown ones', () => {
    const scoped = toolsForTask(tools, { id: 'x', prompt: 'p', tools: ['gamma', 'alpha', 'nope'] })
    expect(scoped.map((tool) => tool.name)).toEqual(['gamma', 'alpha'])
    expect(scoped[0]).toBe(tools[2])
  })

  it('preserves duplicates in the requested list', () => {
    const scoped = toolsForTask(tools, { id: 'x', prompt: 'p', tools: ['beta', 'beta'] })
    expect(scoped.map((tool) => tool.name)).toEqual(['beta', 'beta'])
  })

  it('yields an empty list when nothing requested exists', () => {
    expect(toolsForTask(tools, { id: 'x', prompt: 'p', tools: ['missing'] })).toEqual([])
  })

  it('gives each task its own scoped tool list', async () => {
    const { llm } = probeLlm()
    const tasks = [
      task('t1', 't1', undefined, ['alpha', 'gamma']),
      task('t2', 't2', undefined, ['beta']),
    ]

    const outcome = await runParallel(tasks, {
      llm,
      tools,
      concurrency: 1,
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.results.map((entry) => entry.id)).toEqual(['t1', 't2'])
  })
})

/* -------------------------------------------------------------------------- */
/* (g) empty input                                                            */
/* -------------------------------------------------------------------------- */

describe('runParallel — empty input', () => {
  it('resolves to { ok: true, results: [] } without calling the llm', async () => {
    const { llm, probe } = probeLlm()
    const outcome = await runParallel([], baseOptions(llm))

    expect(outcome).toEqual({ ok: true, results: [] })
    expect(probe.calls).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* (h) event forwarding                                                       */
/* -------------------------------------------------------------------------- */

describe('runParallel — onTaskEvent', () => {
  it('forwards each sub-agent event tagged with the correct task id', async () => {
    const { llm } = probeLlm()
    const tasks = [task('t1', 't1'), task('t2', 't2'), task('t3', 't3')]
    const seen: { id: string; event: AgentEvent }[] = []

    const outcome = await runParallel(
      tasks,
      baseOptions(llm, {
        concurrency: 2,
        onTaskEvent: (id, event) => seen.push({ id, event: event as AgentEvent }),
      }),
    )

    expect(outcome.ok).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((entry) => ['t1', 't2', 't3'].includes(entry.id))).toBe(true)

    for (const id of ['t1', 't2', 't3']) {
      const events = seen.filter((entry) => entry.id === id).map((entry) => entry.event)
      expect(events.some((event) => event.type === 'llm_request')).toBe(true)
      expect(events.some((event) => event.type === 'done')).toBe(true)
    }

    const done = seen.filter((entry) => entry.event.type === 'done')
    expect(done.map((entry) => entry.id).sort()).toEqual(['t1', 't2', 't3'])
  })

  it('works without an observer', async () => {
    const { llm } = probeLlm()
    const outcome = await runParallel([task('t1', 't1')], baseOptions(llm))

    expect(outcome.ok).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* (i) system prompt fallback                                                 */
/* -------------------------------------------------------------------------- */

describe('runParallel — system prompt', () => {
  it('uses the shared systemPrompt when a task does not declare its own', async () => {
    const { llm, probe } = probeLlm()
    const tasks = [
      task('t1', 't1'),
      task('t2', 't2', 'OWN-SYSTEM'),
    ]

    const outcome = await runParallel(
      tasks,
      baseOptions(llm, { concurrency: 1, systemPrompt: 'SHARED-SYSTEM' }),
    )

    expect(outcome.ok).toBe(true)
    expect(probe.seen['t1'][0]).toEqual({ role: 'system', content: 'SHARED-SYSTEM' })
    expect(probe.seen['t2'][0]).toEqual({ role: 'system', content: 'OWN-SYSTEM' })
    expect(outcome.results[0].result.messages[0]).toEqual({
      role: 'system',
      content: 'SHARED-SYSTEM',
    })
  })

  it('omits the system message entirely when neither is provided', async () => {
    const { llm, probe } = probeLlm()
    await runParallel([task('t1', 't1')], baseOptions(llm))

    expect(probe.seen['t1'][0]).toEqual({ role: 'user', content: 't1' })
  })

  it('passes maxSteps and cwd through to the sub-agent loop', async () => {
    const { llm, probe } = probeLlm()
    const outcome = await runParallel([task('t1', 't1')], baseOptions(llm, { maxSteps: 5, cwd: process.cwd() }))

    expect(outcome.ok).toBe(true)
    expect(probe.calls).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Abort                                                                      */
/* -------------------------------------------------------------------------- */

describe('runParallel — abort', () => {
  it('stops scheduling new tasks and marks unstarted ones as Aborted', async () => {
    const { llm, probe } = probeLlm({ delays: { t1: 80, t2: 20, t3: 20 } })
    const tasks = [task('t1', 't1'), task('t2', 't2'), task('t3', 't3')]
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)

    const outcome = await runParallel(
      tasks,
      baseOptions(llm, { concurrency: 1, signal: controller.signal }),
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.results).toHaveLength(3)
    expect(outcome.results.map((entry) => entry.id)).toEqual(['t1', 't2', 't3'])
    expect(outcome.results[1].ok).toBe(false)
    expect(outcome.results[1].error).toBe('Aborted')
    expect(outcome.results[2].ok).toBe(false)
    expect(outcome.results[2].error).toBe('Aborted')
    // Only the task that already held the single worker slot ever hit the llm.
    expect(probe.calls).toBe(1)
  })

  it('marks every task Aborted when the signal is already aborted', async () => {
    const { llm, probe } = probeLlm()
    const tasks = [task('t1', 't1'), task('t2', 't2')]

    const outcome = await runParallel(
      tasks,
      baseOptions(llm, { signal: AbortSignal.abort() }),
    )

    expect(outcome.ok).toBe(false)
    expect(outcome.results.map((entry) => entry.error)).toEqual(['Aborted', 'Aborted'])
    expect(probe.calls).toBe(0)
  })
})
