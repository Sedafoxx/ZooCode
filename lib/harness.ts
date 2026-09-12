/**
 * The agentic loop for the homegrown harness.
 *
 * `runAgent` is the single orchestration primitive the sub-agent and CLI layers
 * build on. It owns no transport and no tool implementations: both arrive via
 * `RunAgentOptions` (`llm` implements the `LlmClient` seam, `tools` is a plain
 * `ToolDef[]`), so the loop can be driven end-to-end by a scripted mock.
 *
 * Contract highlights:
 *  - works on a COPY of the incoming transcript, never mutates the caller's array
 *  - emits a typed `AgentEvent` stream through the optional `onEvent` observer
 *  - returns `{ ok: false }` for all failures, including malformed input; it
 *    does not throw
 */

import type {
  AgentEvent,
  ChatMessage,
  LlmRequest,
  LlmResponse,
  RunAgentOptions,
  RunAgentResult,
  ToolCall,
  ToolContext,
  ToolResult,
} from './types.js'
import { executeTool } from './tools.js'
import { DEFAULT_MAX_STEPS, DEFAULT_MODEL } from './config.js'

// `lib/config.ts` is the single source of truth for these defaults. Re-export
// `DEFAULT_MAX_STEPS` so existing consumers of the harness keep working.
export { DEFAULT_MAX_STEPS }

/** Terminal tool name that stops the loop early with its content as `final`. */
const FINISH_TOOL = 'finish'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Derive the model name for the outbound request: an explicit `options.model`
 * wins, then `DEEPSEEK_MODEL`, then the shared default from `lib/config.ts`.
 */
export function resolveModel(options: RunAgentOptions): string {
  const candidate = options?.model
  if (nonEmpty(candidate)) return candidate
  if (nonEmpty(process.env.DEEPSEEK_MODEL)) return process.env.DEEPSEEK_MODEL
  return DEFAULT_MODEL
}

/**
 * Build a fresh conversation from a user prompt, optionally prefixed with a
 * system prompt.
 */
export function createMessages(userPrompt: string, systemPrompt?: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (systemPrompt !== undefined) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  messages.push({ role: 'user', content: userPrompt })
  return messages
}

/**
 * Extract the final assistant text from a transcript: the last assistant
 * message with non-empty content, or `''` when there is none.
 *
 * Defensive by design: it is also used on the failure path, where the
 * transcript may be partially garbage, so malformed entries (null, non-objects,
 * missing/odd `role` or `content`) are ignored rather than thrown on.
 */
export function finalText(messages: ChatMessage[]): string {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index]
    if (typeof message !== 'object' || message === null) continue
    const record = message as { role?: unknown; content?: unknown }
    if (record.role !== 'assistant') continue
    if (typeof record.content === 'string' && record.content.length > 0) {
      return record.content
    }
  }
  return ''
}

/**
 * Run the agentic loop until the model stops asking for tools, calls `finish`,
 * the step budget is exhausted, or an error/abort occurs.
 *
 * Semantics per step:
 *  1. emit `llm_request`, call `llm.chat`, emit `llm_response`
 *  2. append the reconstructed assistant message (`content` + `toolCalls`)
 *  3. no tool calls  → emit `done`, succeed with the transcript's final text
 *  4. tool calls     → for each, emit `tool_call`, execute, emit `tool_result`,
 *                      append the `tool` message (matching `toolCallId`)
 *  5. a `finish` call stops immediately, using its result content as `final`
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  // Declared outside the try so the catch-all can always report a safe
  // transcript and step count, even when the input itself is malformed.
  let messages: ChatMessage[] = []
  let steps = 0

  /** Emit an event, swallowing observer faults so the loop always survives. */
  const emit = (event: AgentEvent): void => {
    const observer = options?.onEvent
    if (typeof observer !== 'function') return
    try {
      observer(event)
    } catch {
      // A faulty observer must never break the run.
    }
  }

  const fail = (error: string, stepsTaken: number): RunAgentResult => {
    emit({ type: 'error', step: stepsTaken, error })
    return { ok: false, messages, final: finalText(messages), steps: stepsTaken, error }
  }

  const succeed = (stepsTaken: number, final: string): RunAgentResult => {
    emit({ type: 'done', steps: stepsTaken, final })
    return { ok: true, messages, final, steps: stepsTaken }
  }

  try {
    const maxSteps = options?.maxSteps ?? DEFAULT_MAX_STEPS
    const cwd = options?.cwd ?? process.cwd()
    const model = resolveModel(options)
    const tools = Array.isArray(options?.tools) ? options.tools : []

    // Work on a copy so the caller's array (and message objects) stay untouched.
    messages = Array.isArray(options?.messages) ? [...options.messages] : []

    for (let step = 1; step <= maxSteps; step++) {
      if (options?.signal?.aborted) return fail('Aborted', steps)
      steps = step

      emit({ type: 'llm_request', step, messageCount: messages.length })

      const request: LlmRequest = { model, messages }
      if (tools.length > 0) request.tools = tools
      if (options?.signal) request.signal = options.signal

      let response: LlmResponse | undefined
      try {
        response = await options.llm.chat(request)
      } catch (err) {
        return fail(errorMessage(err), step)
      }
      if (options?.signal?.aborted) return fail('Aborted', step)

      const content = response ? response.content ?? null : null
      const calls: ToolCall[] = response ? response.toolCalls ?? [] : []

      emit({ type: 'llm_response', step, content, toolCallCount: calls.length })

      // Reconstruct the assistant turn exactly as the contract requires.
      const assistant: ChatMessage = { role: 'assistant', content }
      if (calls.length > 0) assistant.toolCalls = calls
      messages.push(assistant)

      // No tool calls: the model finished on its own.
      if (calls.length === 0) return succeed(step, finalText(messages))

      for (const call of calls) {
        if (options?.signal?.aborted) return fail('Aborted', step)

        emit({ type: 'tool_call', step, tool: call.name, args: call.args })

        const context: ToolContext = { cwd }
        if (options?.signal) context.signal = options.signal

        let result: ToolResult
        try {
          result = await executeTool(tools, call.name, call.args, context)
        } catch (err) {
          const message = errorMessage(err)
          result = { ok: false, content: message, error: message }
        }

        emit({ type: 'tool_result', step, tool: call.name, ok: result.ok, content: result.content })
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: result.content,
        })

        // Explicit completion: `finish` is a hard stop.
        if (call.name === FINISH_TOOL) return succeed(step, result.content)
      }
    }

    return fail(`Max steps (${maxSteps}) reached without completion`, steps)
  } catch (err) {
    // Safety net: nothing may escape `runAgent`, including malformed input.
    return fail(errorMessage(err), steps)
  }
}
