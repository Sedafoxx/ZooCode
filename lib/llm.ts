/**
 * DeepSeek client (OpenAI-compatible chat completions) plus a scriptable mock.
 *
 * Both implement the `LlmClient` seam defined in `lib/types.ts`, so the harness
 * never depends on the transport. Uses Node's global `fetch` — no dependencies.
 */

import type { ChatMessage, LlmClient, LlmRequest, LlmResponse, LlmUsage, ToolCall, ToolDef } from './types.js'

export interface LlmRequestConfig {
  apiKey: string
  baseUrl: string
  timeoutMs?: number
  maxRetries?: number
}

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_RETRIES = 2
const BASE_BACKOFF_MS = 100
const MAX_BACKOFF_MS = 2_000

/* -------------------------------------------------------------------------- */
/* Wire types (OpenAI-compatible)                                             */
/* -------------------------------------------------------------------------- */

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface WireMessage {
  role: string
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

interface WireRequestBody {
  model: string
  messages: WireMessage[]
  temperature?: number
  max_tokens?: number
  tools?: WireTool[]
  tool_choice?: 'auto'
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `JSON.stringify` that never throws and always yields a JSON object string. */
function stringifyArgs(args: unknown): string {
  if (typeof args === 'string') return args
  if (args === undefined || args === null) return '{}'
  try {
    const encoded = JSON.stringify(args)
    return typeof encoded === 'string' ? encoded : '{}'
  } catch {
    return '{}'
  }
}

/** Parse a tool-call `arguments` payload; invalid JSON degrades to `{}`. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/* -------------------------------------------------------------------------- */
/* Outbound mapping                                                           */
/* -------------------------------------------------------------------------- */

/** Convert harness `ChatMessage[]` into OpenAI-compatible wire messages. */
export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map((message): WireMessage => {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.toolCalls.map((call): WireToolCall => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: stringifyArgs(call.args) },
        })),
      }
    }

    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content ?? '',
      }
    }

    return { role: message.role, content: message.content ?? '' }
  })
}

/** Convert harness `ToolDef[]` into OpenAI-compatible function tools. */
export function toWireTools(tools: ToolDef[]): WireTool[] {
  return tools.map((tool): WireTool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/* -------------------------------------------------------------------------- */
/* Inbound parsing                                                            */
/* -------------------------------------------------------------------------- */

/** Parse an OpenAI-style completion payload into an `LlmResponse`. */
export function parseCompletionResponse(payload: unknown): LlmResponse {
  const root = isRecord(payload) ? payload : {}
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : {}
  const message = isRecord(choice.message) ? choice.message : {}

  const content = typeof message.content === 'string' ? message.content : null

  const toolCalls: ToolCall[] = []
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const raw of rawCalls) {
    if (!isRecord(raw)) continue
    const fn = isRecord(raw.function) ? raw.function : {}
    toolCalls.push({
      id: typeof raw.id === 'string' ? raw.id : '',
      name: typeof fn.name === 'string' ? fn.name : '',
      args: parseArgs(fn.arguments),
    })
  }

  const response: LlmResponse = { content }
  if (toolCalls.length > 0) response.toolCalls = toolCalls
  if (typeof choice.finish_reason === 'string') response.finishReason = choice.finish_reason

  if (isRecord(root.usage)) {
    const usage: LlmUsage = {}
    if (typeof root.usage.prompt_tokens === 'number') usage.promptTokens = root.usage.prompt_tokens
    if (typeof root.usage.completion_tokens === 'number') {
      usage.completionTokens = root.usage.completion_tokens
    }
    if (Object.keys(usage).length > 0) response.usage = usage
  }

  return response
}

/* -------------------------------------------------------------------------- */
/* Real client                                                                */
/* -------------------------------------------------------------------------- */

interface AttemptOk {
  ok: true
  value: LlmResponse
}

interface AttemptErr {
  ok: false
  error: Error
  retryable: boolean
}

type Attempt = AttemptOk | AttemptErr

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed.slice(0, 500) : ''
  } catch {
    return ''
  }
}

async function attemptOnce(
  url: string,
  apiKey: string,
  timeoutMs: number,
  body: WireRequestBody,
  signal: AbortSignal | undefined,
): Promise<Attempt> {
  const controller = new AbortController()
  let timedOut = false

  if (signal?.aborted) {
    return { ok: false, error: new Error('DeepSeek request aborted before it started'), retryable: false }
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const detail = await readErrorBody(response)
      const statusText = response.statusText ? ` ${response.statusText}` : ''
      const suffix = detail ? ` - ${detail}` : ''
      return {
        ok: false,
        error: new Error(`DeepSeek request failed: HTTP ${response.status}${statusText}${suffix}`),
        retryable: response.status === 429 || response.status >= 500,
      }
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return {
        ok: false,
        error: new Error('DeepSeek request failed: response body was not valid JSON'),
        retryable: false,
      }
    }

    return { ok: true, value: parseCompletionResponse(payload) }
  } catch (err) {
    if (timedOut) {
      return {
        ok: false,
        error: new Error(`DeepSeek request timed out after ${timeoutMs}ms`),
        retryable: true,
      }
    }
    if (signal?.aborted) {
      return { ok: false, error: new Error('DeepSeek request aborted'), retryable: false }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: new Error(`DeepSeek request failed: ${message}`), retryable: true }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Create a DeepSeek chat client. Throws (rather than returning a malformed
 * success) when the request cannot be completed after retries.
 */
export function createDeepSeekClient(config: LlmRequestConfig): LlmClient {
  const baseUrl = (config.baseUrl ?? '').trim().replace(/\/+$/, '')
  const url = `${baseUrl}/chat/completions`
  const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const rawRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
  const maxRetries = Number.isFinite(rawRetries) && rawRetries > 0 ? Math.floor(rawRetries) : 0

  return {
    async chat(req: LlmRequest): Promise<LlmResponse> {
      const body: WireRequestBody = {
        model: req.model,
        messages: toWireMessages(req.messages),
      }
      if (req.temperature !== undefined) body.temperature = req.temperature
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
      if (req.tools && req.tools.length > 0) {
        body.tools = toWireTools(req.tools)
        body.tool_choice = 'auto'
      }

      let lastError: Error | undefined

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
          await delay(backoff)
        }

        const outcome = await attemptOnce(url, config.apiKey, timeoutMs, body, req.signal)
        if (outcome.ok) return outcome.value

        lastError = outcome.error
        if (!outcome.retryable) throw outcome.error
      }

      throw new Error(
        `${lastError?.message ?? 'DeepSeek request failed'} (gave up after ${maxRetries + 1} attempts)`,
      )
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Mock client                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Scriptable `LlmClient` for tests.
 *
 * - Array form: responses are returned in order. The last response repeats once
 *   the sequence runs out; an empty array is rejected with a helpful error.
 * - Function form: the callback computes each response from the request.
 */
export function createMockLlmClient(
  scripted: ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>) | LlmResponse[],
): LlmClient {
  if (typeof scripted === 'function') {
    return {
      async chat(req: LlmRequest): Promise<LlmResponse> {
        return await scripted(req)
      },
    }
  }

  if (!Array.isArray(scripted) || scripted.length === 0) {
    throw new Error(
      'createMockLlmClient requires a non-empty array of responses or a function (req) => response',
    )
  }

  const responses: LlmResponse[] = scripted
  let index = 0

  return {
    async chat(): Promise<LlmResponse> {
      if (index >= responses.length) {
        const last = responses[responses.length - 1]
        // Sequence exhausted: repeat the final scripted response.
        return last
      }
      const response = responses[index]
      index += 1
      return response
    },
  }
}
