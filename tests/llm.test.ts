import { describe, it, expect, afterEach } from 'vitest'
import { createDeepSeekClient, createMockLlmClient } from '../lib/llm.js'
import type { ChatMessage, LlmRequest, ToolDef } from '../lib/types.js'

/* -------------------------------------------------------------------------- */
/* Fake fetch (no network)                                                    */
/* -------------------------------------------------------------------------- */

interface FetchCall {
  url: string
  init: RequestInit
}

const originalFetch: typeof fetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Install a fake `globalThis.fetch`; returns the captured calls. */
function installFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = []

  const fake = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input)
    const resolved = init ?? {}
    calls.push({ url, init: resolved })
    return await handler(url, resolved)
  }

  globalThis.fetch = fake as unknown as typeof fetch
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(body: string, status: number, statusText?: string): Response {
  return new Response(body, { status, statusText })
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeRequest(): LlmRequest {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are Zoo.' },
    { role: 'user', content: 'read the types file' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_1', name: 'read_file', args: { path: 'lib/types.ts' } }],
    },
    { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: '{"ok":true}' },
  ]

  return {
    model: 'deepseek-chat',
    temperature: 0.2,
    maxTokens: 1024,
    messages,
  }
}

function makeTools(): ToolDef[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path to read' } },
        required: ['path'],
      },
      handler: async () => ({ ok: true, content: '' }),
    },
  ]
}

const CANNED_COMPLETION = {
  id: 'chatcmpl-1',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'write_file', arguments: '{"path":"a.txt","text":"hi"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
}

/* -------------------------------------------------------------------------- */
/* Mock client                                                                */
/* -------------------------------------------------------------------------- */

describe('createMockLlmClient', () => {
  it('returns array-scripted responses in order', async () => {
    const client = createMockLlmClient([
      { content: 'first', finishReason: 'stop' },
      { content: 'second', finishReason: 'stop' },
    ])

    expect((await client.chat(makeRequest())).content).toBe('first')
    expect((await client.chat(makeRequest())).content).toBe('second')
  })

  it('repeats the last scripted response once the sequence is exhausted', async () => {
    const client = createMockLlmClient([
      { content: 'only' },
      { content: 'last' },
    ])

    await client.chat(makeRequest())
    expect((await client.chat(makeRequest())).content).toBe('last')
    expect((await client.chat(makeRequest())).content).toBe('last')
  })

  it('throws a helpful error when scripted with an empty array', () => {
    expect(() => createMockLlmClient([])).toThrow(/non-empty array/)
  })

  it('computes responses with the function form', async () => {
    const requests: LlmRequest[] = []
    const client = createMockLlmClient((req) => {
      requests.push(req)
      return { content: `echo:${req.messages.length}` }
    })

    const result = await client.chat(makeRequest())

    expect(result.content).toBe('echo:4')
    expect(requests).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Real client                                                                */
/* -------------------------------------------------------------------------- */

describe('createDeepSeekClient', () => {
  it('maps ChatMessage[]/ToolDef[] to wire JSON and parses an OpenAI-style response', async () => {
    const calls = installFetch(() => jsonResponse(CANNED_COMPLETION))
    const client = createDeepSeekClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.test',
    })

    const response = await client.chat({ ...makeRequest(), tools: makeTools() })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.example.test/chat/completions')
    expect(calls[0].init.method).toBe('POST')

    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')
    expect(headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    expect(body.model).toBe('deepseek-chat')
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(1024)
    expect(body.tool_choice).toBe('auto')

    expect(body.messages).toEqual([
      { role: 'system', content: 'You are Zoo.' },
      { role: 'user', content: 'read the types file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"lib/types.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ])

    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from disk',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Path to read' } },
            required: ['path'],
          },
        },
      },
    ])

    // Parsed response: tool_call arguments are real objects, not strings.
    expect(response.content).toBeNull()
    expect(response.finishReason).toBe('tool_calls')
    expect(response.usage).toEqual({ promptTokens: 11, completionTokens: 5 })
    expect(response.toolCalls).toEqual([
      { id: 'call_2', name: 'write_file', args: { path: 'a.txt', text: 'hi' } },
    ])
  })

  it('omits tools/tool_choice when none are supplied and keeps text content', async () => {
    const calls = installFetch(() =>
      jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      }),
    )
    const client = createDeepSeekClient({ apiKey: 'k', baseUrl: 'https://api.example.test/' })

    const response = await client.chat({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(calls[0].url).toBe('https://api.example.test/chat/completions')
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(response.content).toBe('hello')
    expect(response.toolCalls).toBeUndefined()
  })

  it('degrades invalid tool-call argument JSON to {} instead of throwing', async () => {
    installFetch(() =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_x', type: 'function', function: { name: 'read_file', arguments: '{not json' } },
                { id: 'call_y', type: 'function', function: { name: 'read_file', arguments: '' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    )
    const client = createDeepSeekClient({ apiKey: 'k', baseUrl: 'https://api.example.test' })

    const response = await client.chat(makeRequest())

    expect(response.toolCalls).toEqual([
      { id: 'call_x', name: 'read_file', args: {} },
      { id: 'call_y', name: 'read_file', args: {} },
    ])
  })

  it('throws a clear error after retrying an HTTP 500, and never returns malformed success', async () => {
    const calls = installFetch(() => textResponse('boom', 500, 'Internal Server Error'))
    const client = createDeepSeekClient({ apiKey: 'k', baseUrl: 'https://api.example.test' })

    await expect(client.chat(makeRequest())).rejects.toThrow(/HTTP 500/)

    // default maxRetries = 2 -> 3 attempts total
    expect(calls).toHaveLength(3)
  })

  it('does not retry non-retryable HTTP errors', async () => {
    const calls = installFetch(() => textResponse('nope', 401, 'Unauthorized'))
    const client = createDeepSeekClient({ apiKey: 'k', baseUrl: 'https://api.example.test' })

    await expect(client.chat(makeRequest())).rejects.toThrow(/HTTP 401/)
    expect(calls).toHaveLength(1)
  })

  it('throws a clear error when fetch rejects (network failure)', async () => {
    const calls = installFetch(() => {
      throw new TypeError('fetch failed')
    })
    const client = createDeepSeekClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test',
      maxRetries: 0,
    })

    await expect(client.chat(makeRequest())).rejects.toThrow(/DeepSeek request failed/)
    expect(calls).toHaveLength(1)
  })

  it('honours an already-aborted request signal without calling fetch', async () => {
    const calls = installFetch(() => jsonResponse({ choices: [] }))
    const controller = new AbortController()
    controller.abort()
    const client = createDeepSeekClient({ apiKey: 'k', baseUrl: 'https://api.example.test' })

    await expect(client.chat({ ...makeRequest(), signal: controller.signal })).rejects.toThrow(
      /aborted/,
    )
    expect(calls).toHaveLength(0)
  })
})
