/**
 * THE CONTRACT for the homegrown agent harness.
 *
 * Every other module (tool registry, agent loop, sub-agents, CLI) imports these
 * names verbatim. Treat this file as append-only: do not rename existing members.
 */

// Type-only (erased at runtime) so the contract can name the context-budget
// shapes without creating a runtime dependency edge on `lib/context-budget.ts`.
import type { ContextBudgetOptions, ContextStats } from './context-budget.js'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ChatMessage {
  role: Role
  content: string | null
  toolCalls?: ToolCall[]     // present on assistant messages that requested tools
  toolCallId?: string        // present on 'tool' result messages
  name?: string              // tool name for 'tool' messages
}

export interface ToolPropertySchema {
  type: string
  description?: string
  enum?: string[]
  items?: Record<string, unknown>
}

export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, ToolPropertySchema>
  required?: string[]
}

export interface ToolContext {
  cwd: string
  signal?: AbortSignal
}

export interface ToolResult {
  ok: boolean
  content: string   // stringified payload sent back to the model
  error?: string
}

export interface ToolDef {
  name: string
  description: string
  parameters: ToolParameterSchema
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

export interface LlmRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface LlmUsage { promptTokens?: number; completionTokens?: number }

export interface LlmResponse {
  content: string | null
  toolCalls?: ToolCall[]
  usage?: LlmUsage
  finishReason?: string
}

/** The seam: harness only knows this interface. */
export interface LlmClient {
  chat(req: LlmRequest): Promise<LlmResponse>
}

export type AgentEvent =
  | { type: 'llm_request'; step: number; messageCount: number }
  | { type: 'llm_response'; step: number; content: string | null; toolCallCount: number }
  | { type: 'tool_call'; step: number; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; step: number; tool: string; ok: boolean; content: string }
  // Emitted (only) when the step's outbound transcript was actually pruned.
  | { type: 'context_pruned'; step: number; stats: ContextStats }
  | { type: 'done'; steps: number; final: string }
  | { type: 'error'; step: number; error: string }

export interface RunAgentOptions {
  llm: LlmClient
  tools: ToolDef[]
  messages: ChatMessage[]
  maxSteps?: number
  /** Explicit model override; falls back to `DEEPSEEK_MODEL` then the default. */
  model?: string
  cwd?: string
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
  /**
   * Estimated-token ceiling for the transcript handed to the model on each step.
   * Omitted fields fall back to `DEFAULT_CONTEXT_BUDGET` in `lib/context-budget.ts`.
   * This only affects the OUTBOUND request; `RunAgentResult.messages` still holds
   * the full transcript.
   */
  contextBudget?: Partial<ContextBudgetOptions>
}

export interface RunAgentResult {
  ok: boolean
  messages: ChatMessage[]
  final: string
  steps: number
  error?: string
  /**
   * The LAST applied `ContextStats` of the run — i.e. the one from the most
   * recent step that pruned — or `undefined` when nothing was ever pruned.
   * Per-step stats are also available on the `context_pruned` event.
   */
  context?: ContextStats
}

export interface SubTask {
  id: string
  prompt: string
  system?: string
  tools?: string[]   // tool names to restrict to (if omitted, all tools available)
}
