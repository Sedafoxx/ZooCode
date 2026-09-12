import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { estimateMessagesTokens } from '../lib/context-budget.js'
import {
  DEFAULT_MAX_STEPS,
  createMessages,
  finalText,
  resolveModel,
  runAgent,
} from '../lib/harness.js'
import { createMockLlmClient } from '../lib/llm.js'
import { createCoreTools } from '../lib/tools.js'
import type {
  AgentEvent,
  ChatMessage,
  LlmClient,
  LlmRequest,
  RunAgentOptions,
  ToolDef,
  ToolResult,
} from '../lib/types.js'

/* -------------------------------------------------------------------------- */
/* Fixtures + helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Minimal deterministic tool used to exercise the tool-call path. */
function echoTool(): ToolDef {
  return {
    name: 'echo',
    description: 'Echo the supplied text back to the model.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
    },
    handler: async (args) => ({ ok: true, content: `echoed:${String(args.text)}` }),
  }
}

function user(text: string): ChatMessage[] {
  return [{ role: 'user', content: text }]
}

const savedModelEnv = process.env.DEEPSEEK_MODEL

beforeEach(() => {
  delete process.env.DEEPSEEK_MODEL
})

afterEach(() => {
  if (savedModelEnv === undefined) delete process.env.DEEPSEEK_MODEL
  else process.env.DEEPSEEK_MODEL = savedModelEnv
})

/* -------------------------------------------------------------------------- */
/* createMessages / finalText                                                 */
/* -------------------------------------------------------------------------- */

describe('createMessages', () => {
  it('returns just the user message without a system prompt', () => {
    expect(createMessages('hello')).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('prefixes a system prompt when one is given', () => {
    expect(createMessages('hello', 'you are a bot')).toEqual([
      { role: 'system', content: 'you are a bot' },
      { role: 'user', content: 'hello' },
    ])
  })
})

describe('finalText', () => {
  it('returns the last assistant message with non-empty content', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]
    expect(finalText(messages)).toBe('second')
  })

  it('skips empty assistant content and trailing tool messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'answer' },
      { role: 'assistant', content: null, toolCalls: [{ id: '1', name: 'echo', args: {} }] },
      { role: 'tool', toolCallId: '1', name: 'echo', content: 'echoed:hi' },
    ]
    expect(finalText(messages)).toBe('answer')
  })

  it('returns an empty string when there is no assistant text', () => {
    expect(finalText([])).toBe('')
    expect(finalText(user('hi'))).toBe('')
    expect(finalText([{ role: 'assistant', content: null }])).toBe('')
  })

  it('ignores null / malformed entries instead of throwing', () => {
    expect(finalText([null as unknown as ChatMessage])).toBe('')
    expect(finalText([{ content: 'no role' } as unknown as ChatMessage])).toBe('')
    expect(finalText([{ role: 'assistant' } as unknown as ChatMessage])).toBe('')
    expect(finalText(null as unknown as ChatMessage[])).toBe('')
  })
})

describe('resolveModel', () => {
  const base = {
    llm: createMockLlmClient([{ content: 'ok' }]),
    tools: [],
    messages: user('hi'),
  }

  it('prefers an explicit options.model value', () => {
    const options: RunAgentOptions = { ...base, model: 'custom-model' }
    expect(resolveModel(options)).toBe('custom-model')
  })

  it('falls back to DEEPSEEK_MODEL', () => {
    process.env.DEEPSEEK_MODEL = 'env-model'
    expect(resolveModel(base)).toBe('env-model')
  })

  it('defaults to deepseek-chat', () => {
    expect(resolveModel(base)).toBe('deepseek-chat')
  })
})

/* -------------------------------------------------------------------------- */
/* runAgent                                                                   */
/* -------------------------------------------------------------------------- */

describe('runAgent', () => {
  it('(a) ends immediately on a text-only response', async () => {
    const events: AgentEvent[] = []
    const result = await runAgent({
      llm: createMockLlmClient([{ content: 'hello there' }]),
      tools: [],
      messages: user('hi'),
      onEvent: (event) => events.push(event),
    })

    expect(result.ok).toBe(true)
    expect(result.final).toBe('hello there')
    expect(result.steps).toBe(1)
    expect(result.error).toBeUndefined()
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toEqual({ role: 'user', content: 'hi' })
    expect(result.messages[1]).toEqual({ role: 'assistant', content: 'hello there' })
    expect(events.map((event) => event.type)).toEqual(['llm_request', 'llm_response', 'done'])
  })

  it('(b) executes a tool call, then finishes on the follow-up text', async () => {
    const result = await runAgent({
      llm: createMockLlmClient([
        { content: null, toolCalls: [{ id: 'call-1', name: 'echo', args: { text: 'hi' } }] },
        { content: 'all done' },
      ]),
      tools: [echoTool()],
      messages: user('please echo hi'),
    })

    expect(result.ok).toBe(true)
    expect(result.steps).toBe(2)
    expect(result.final).toBe('all done')

    const assistantCalls = result.messages.filter(
      (message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0,
    )
    expect(assistantCalls).toHaveLength(1)
    expect(assistantCalls[0].content).toBeNull()
    expect(assistantCalls[0].toolCalls).toEqual([{ id: 'call-1', name: 'echo', args: { text: 'hi' } }])

    const toolMessages = result.messages.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0].toolCallId).toBe('call-1')
    expect(toolMessages[0].name).toBe('echo')
    expect(toolMessages[0].content).toBe('echoed:hi')

    expect(result.messages).toHaveLength(4)
    expect(result.messages[3]).toEqual({ role: 'assistant', content: 'all done' })
  })

  it('(c) stops early when the finish tool is called', async () => {
    let calls = 0
    const llm: LlmClient = {
      chat: async () => {
        calls += 1
        return { content: null, toolCalls: [{ id: 'fin-1', name: 'finish', args: { summary: 'All done' } }] }
      },
    }
    const events: AgentEvent[] = []

    const result = await runAgent({
      llm,
      tools: createCoreTools(),
      messages: user('do the thing'),
      onEvent: (event) => events.push(event),
    })

    expect(result.ok).toBe(true)
    expect(result.final).toBe('All done')
    expect(result.steps).toBe(1)
    expect(calls).toBe(1)
    expect(result.messages.at(-1)).toEqual({
      role: 'tool',
      toolCallId: 'fin-1',
      name: 'finish',
      content: 'All done',
    })
    expect(events.map((event) => event.type)).toEqual([
      'llm_request',
      'llm_response',
      'tool_call',
      'tool_result',
      'done',
    ])
    expect(events.at(-1)).toEqual({ type: 'done', steps: 1, final: 'All done' })
  })

  it('(d) reports an error when maxSteps is exhausted', async () => {
    let calls = 0
    const llm: LlmClient = {
      chat: async () => {
        calls += 1
        return { content: null, toolCalls: [{ id: `call-${calls}`, name: 'echo', args: { text: 'x' } }] }
      },
    }
    const events: AgentEvent[] = []

    const result = await runAgent({
      llm,
      tools: [echoTool()],
      messages: user('loop forever'),
      maxSteps: 3,
      onEvent: (event) => events.push(event),
    })

    expect(result.ok).toBe(false)
    expect(result.steps).toBe(3)
    expect(result.error).toContain('Max steps')
    expect(result.error).toContain('3')
    expect(calls).toBe(3)
    expect(events.at(-1)?.type).toBe('error')
  })

  it('(e) captures a thrown llm error instead of throwing', async () => {
    const llm: LlmClient = {
      chat: async () => {
        throw new Error('boom')
      },
    }
    const events: AgentEvent[] = []

    const result = await runAgent({
      llm,
      tools: [],
      messages: user('hi'),
      onEvent: (event) => events.push(event),
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('boom')
    expect(result.steps).toBe(1)
    expect(result.messages).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'error', step: 1, error: 'boom' })
  })

  it('(f) returns an aborted result for a signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const llm: LlmClient = {
      chat: async () => {
        calls += 1
        return { content: 'never' }
      },
    }

    const result = await runAgent({
      llm,
      tools: [],
      messages: user('hi'),
      signal: controller.signal,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('Aborted')
    expect(result.steps).toBe(0)
    expect(calls).toBe(0)
  })

  it('(f) aborts mid-run before the pending tool call', async () => {
    const controller = new AbortController()
    const events: AgentEvent[] = []

    const result = await runAgent({
      llm: createMockLlmClient([
        { content: null, toolCalls: [{ id: 'call-1', name: 'echo', args: { text: 'hi' } }] },
        { content: 'unreachable' },
      ]),
      tools: [echoTool()],
      messages: user('hi'),
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event)
        if (event.type === 'llm_response') controller.abort()
      },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('Aborted')
    expect(events.some((event) => event.type === 'tool_call')).toBe(false)
  })

  it('(g) emits events in the expected order across a tool round-trip', async () => {
    const events: AgentEvent[] = []

    const result = await runAgent({
      llm: createMockLlmClient([
        { content: null, toolCalls: [{ id: 'call-1', name: 'echo', args: { text: 'hi' } }] },
        { content: 'all done' },
      ]),
      tools: [echoTool()],
      messages: user('hi'),
      onEvent: (event) => events.push(event),
    })

    expect(result.ok).toBe(true)
    expect(events.map((event) => event.type)).toEqual([
      'llm_request',
      'llm_response',
      'tool_call',
      'tool_result',
      'llm_request',
      'llm_response',
      'done',
    ])
    expect(events[0]).toEqual({ type: 'llm_request', step: 1, messageCount: 1 })
    expect(events[1]).toEqual({ type: 'llm_response', step: 1, content: null, toolCallCount: 1 })
    expect(events[2]).toEqual({ type: 'tool_call', step: 1, tool: 'echo', args: { text: 'hi' } })
    expect(events[3]).toEqual({
      type: 'tool_result',
      step: 1,
      tool: 'echo',
      ok: true,
      content: 'echoed:hi',
    })
    expect(events[4]).toEqual({ type: 'llm_request', step: 2, messageCount: 3 })
    expect(events[6]).toEqual({ type: 'done', steps: 2, final: 'all done' })
  })

  it('(h) does not mutate the caller messages array', async () => {
    const input: ChatMessage[] = user('hi')
    const snapshot = JSON.stringify(input)

    const result = await runAgent({
      llm: createMockLlmClient([{ content: 'bye' }]),
      tools: [],
      messages: input,
    })

    expect(JSON.stringify(input)).toBe(snapshot)
    expect(input).toHaveLength(1)
    expect(result.messages).not.toBe(input)
    expect(result.messages).toHaveLength(2)
  })

  it('(i) survives an onEvent observer that throws', async () => {
    const result = await runAgent({
      llm: createMockLlmClient([
        { content: null, toolCalls: [{ id: 'call-1', name: 'echo', args: { text: 'hi' } }] },
        { content: 'all done' },
      ]),
      tools: [echoTool()],
      messages: user('hi'),
      onEvent: () => {
        throw new Error('observer boom')
      },
    })

    expect(result.ok).toBe(true)
    expect(result.final).toBe('all done')
    expect(result.steps).toBe(2)
  })

  it('passes the resolved model, tools and signal through to the llm', async () => {
    const seen: LlmRequest[] = []
    const controller = new AbortController()
    const llm: LlmClient = {
      chat: async (req) => {
        seen.push(req)
        return { content: 'ok' }
      },
    }
    const tools = [echoTool()]

    await runAgent({
      llm,
      tools,
      messages: user('hi'),
      cwd: process.cwd(),
      signal: controller.signal,
    })

    expect(seen).toHaveLength(1)
    expect(seen[0].model).toBe('deepseek-chat')
    expect(seen[0].tools).toBe(tools)
    expect(seen[0].signal).toBe(controller.signal)
  })

  it('omits tools from the request when none are configured', async () => {
    const seen: LlmRequest[] = []
    const llm: LlmClient = {
      chat: async (req) => {
        seen.push(req)
        return { content: 'ok' }
      },
    }

    await runAgent({ llm, tools: [], messages: user('hi') })

    expect(seen[0].tools).toBeUndefined()
  })

  it('turns an unknown tool into a failed tool result and keeps going', async () => {
    const result = await runAgent({
      llm: createMockLlmClient([
        { content: null, toolCalls: [{ id: 'call-1', name: 'nope', args: {} }] },
        { content: 'recovered' },
      ]),
      tools: [],
      messages: user('hi'),
    })

    expect(result.ok).toBe(true)
    expect(result.final).toBe('recovered')
    const toolMessage = result.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toContain('Unknown tool: nope')
    expect(toolMessage?.toolCallId).toBe('call-1')
  })

  it('(j) returns ok:false (no throw) for a null entry in the transcript', async () => {
    const llm: LlmClient = {
      chat: async () => {
        throw new Error('x')
      },
    }

    const result = await runAgent({
      llm,
      tools: [],
      messages: [null as unknown as ChatMessage],
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('x')
    expect(result.final).toBe('')
    expect(Array.isArray(result.messages)).toBe(true)
  })

  it('(k) survives a tool handler returning a malformed result and keeps looping', async () => {
    const malformed: ToolDef = {
      name: 'weird',
      description: 'returns a non-ToolResult object',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ nope: true }) as unknown as ToolResult,
    }

    const result = await runAgent({
      llm: createMockLlmClient([
        { content: null, toolCalls: [{ id: 'c1', name: 'weird', args: {} }] },
        { content: 'recovered' },
      ]),
      tools: [malformed],
      messages: user('hi'),
    })

    expect(result.ok).toBe(true)
    expect(result.final).toBe('recovered')
    const toolMessage = result.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toContain('invalid result')
  })

  it('(l) does not throw when a transcript entry has no role', async () => {
    const result = await runAgent({
      llm: createMockLlmClient([{ content: 'ok' }]),
      tools: [],
      messages: [{ content: 'missing role' } as unknown as ChatMessage],
    })

    expect(result.ok).toBe(true)
    expect(result.final).toBe('ok')
  })

  it('forwards an explicit options.model to llm.chat', async () => {
    const seen: LlmRequest[] = []
    const llm: LlmClient = {
      chat: async (req) => {
        seen.push(req)
        return { content: 'ok' }
      },
    }

    await runAgent({ llm, tools: [], messages: user('hi'), model: 'my-model' })

    expect(seen).toHaveLength(1)
    expect(seen[0].model).toBe('my-model')
  })

  it('exposes DEFAULT_MAX_STEPS as 25', () => {
    expect(DEFAULT_MAX_STEPS).toBe(25)
  })
})

/* -------------------------------------------------------------------------- */
/* runAgent + context budget                                                  */
/* -------------------------------------------------------------------------- */

describe('runAgent — context budget', () => {
  /** Deterministic tool returning a large payload, to force pruning. */
  function bigTool(chars: number): ToolDef {
    return {
      name: 'big',
      description: 'Return a large payload.',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ ok: true, content: 'y'.repeat(chars) }),
    }
  }

  /**
   * Return one string per assistant-with-toolCalls message that is not answered
   * by the immediately-following `tool` messages (the DeepSeek wire rule).
   */
  function pairingViolations(messages: ChatMessage[]): string[] {
    const violations: string[] = []
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (!message || message.role !== 'assistant') continue
      const calls = message.toolCalls
      if (!Array.isArray(calls) || calls.length === 0) continue

      const answered = new Set<string>()
      let next = index + 1
      while (next < messages.length && messages[next]?.role === 'tool') {
        const id = messages[next].toolCallId
        if (typeof id === 'string') answered.add(id)
        next += 1
      }
      for (const call of calls) {
        if (!answered.has(call.id)) violations.push(`message ${index}: ${call.id} unanswered`)
      }
    }
    return violations
  }

  it('prunes the OUTBOUND transcript while returning the FULL history', async () => {
    const rounds = 6
    const resultChars = 4_000
    let step = 0
    const seen: LlmRequest[] = []
    const llm: LlmClient = {
      chat: async (req) => {
        seen.push(req)
        step += 1
        if (step <= rounds) {
          return { content: null, toolCalls: [{ id: `call-${step}`, name: 'big', args: {} }] }
        }
        return { content: 'finished' }
      },
    }
    const events: AgentEvent[] = []

    const result = await runAgent({
      llm,
      tools: [bigTool(resultChars)],
      messages: user('go'),
      maxSteps: 12,
      contextBudget: { budgetTokens: 3_000, keepRecentGroups: 1 },
      onEvent: (event) => events.push(event),
    })

    expect(result.ok).toBe(true)
    expect(result.final).toBe('finished')

    // (i) The transcript handed to a LATER llm.chat is smaller than the full one.
    const lastRequest = seen.at(-1) as LlmRequest
    expect(estimateMessagesTokens(lastRequest.messages)).toBeLessThan(
      estimateMessagesTokens(result.messages),
    )
    // ...and the pruned request is still wire-valid (pairing invariant).
    expect(pairingViolations(lastRequest.messages)).toEqual([])

    // (ii) `context_pruned` fired with plausible stats.
    const prunedEvents = events.filter((event) => event.type === 'context_pruned')
    expect(prunedEvents.length).toBeGreaterThan(0)
    const firstPruned = prunedEvents[0]
    if (firstPruned.type !== 'context_pruned') throw new Error('unreachable')
    expect(firstPruned.stats.originalTokens).toBeGreaterThan(firstPruned.stats.finalTokens)
    expect(firstPruned.stats.pruned).toBe(true)
    expect(firstPruned.step).toBeGreaterThanOrEqual(1)
    expect(result.context?.pruned).toBe(true)
    expect(result.context?.elidedResults).toBeGreaterThan(0)

    // (iii) The transcript RETURNED to the caller is still the full one.
    expect(result.messages).toHaveLength(1 + rounds * 2 + 1)
    const returnedToolMessages = result.messages.filter((message) => message.role === 'tool')
    expect(returnedToolMessages).toHaveLength(rounds)
    for (const message of returnedToolMessages) {
      expect(message.content).toHaveLength(resultChars)
    }
  })

  it('emits no context_pruned event when the transcript fits the budget', async () => {
    const events: AgentEvent[] = []
    const result = await runAgent({
      llm: createMockLlmClient([{ content: 'ok' }]),
      tools: [],
      messages: user('hi'),
      onEvent: (event) => events.push(event),
    })

    expect(result.ok).toBe(true)
    expect(events.some((event) => event.type === 'context_pruned')).toBe(false)
    expect(result.context).toBeUndefined()
  })

  it('never mutates the caller transcript even when pruning', async () => {
    const input = user('go')
    const snapshot = JSON.stringify(input)

    const result = await runAgent({
      llm: createMockLlmClient([
        { content: null, toolCalls: [{ id: 'c1', name: 'big', args: {} }] },
        { content: 'done' },
      ]),
      tools: [bigTool(4_000)],
      messages: input,
      contextBudget: { budgetTokens: 100, keepRecentGroups: 1 },
    })

    expect(result.ok).toBe(true)
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(input).toHaveLength(1)
  })
})
