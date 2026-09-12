/**
 * Context budgeting for the agent loop — bound and manage the transcript.
 *
 * The agent loop re-sends the WHOLE transcript on every step, so a long run can
 * re-send hundreds of thousands of tokens. This module shrinks the transcript
 * that is handed to the model while leaving the caller's history untouched.
 *
 * THE CRITICAL INVARIANT (OpenAI-compatible / DeepSeek)
 * -----------------------------------------------------
 * A request is rejected when an `assistant` message carries `toolCalls` and the
 * IMMEDIATELY following messages do not answer EVERY one of those `toolCallId`s
 * with a `tool` result (no other message type interleaved).
 *
 * So pruning only ever happens on whole GROUPS:
 *
 *   - a **group** = an `assistant` message that has `toolCalls`, plus ALL the
 *     immediately-following `role: 'tool'` messages that answer it;
 *   - every other message is its own single-message group.
 *
 * Within an unprotected group we may **elide** a tool result's `content` (the
 * message, its `toolCallId` and its position stay exactly where they were), or
 * we may drop the ENTIRE group (the assistant `toolCalls` message together with
 * all of its results). A subset of a group is never dropped and never reordered,
 * and a call is never separated from its results.
 *
 * Everything here is pure and synchronous: it never touches the network, never
 * mutates its input, and never throws.
 */

import type { ChatMessage, ToolCall } from './types.js'
// `lib/config.ts` (L0) is the single source of truth for the numeric defaults,
// so `ZOO_CONTEXT_BUDGET_TOKENS` / `ZOO_CONTEXT_KEEP_GROUPS` and the library
// defaults can never drift apart.
import { DEFAULT_CONTEXT_BUDGET_TOKENS, DEFAULT_CONTEXT_KEEP_GROUPS } from './config.js'

export interface ContextBudgetOptions {
  /** Estimated-token ceiling for the whole transcript. */
  budgetTokens: number
  /** Always keep the most recent N groups verbatim. */
  keepRecentGroups: number
  /** Only elide a tool result whose content exceeds this many characters. */
  minElideChars: number
}

export interface ContextStats {
  pruned: boolean
  originalTokens: number
  finalTokens: number
  originalMessages: number
  finalMessages: number
  elidedResults: number
  droppedGroups: number
  groups: number
}

/** Only elide tool results longer than this many characters by default. */
export const DEFAULT_MIN_ELIDE_CHARS = 400

/**
 * Sensible, documented defaults.
 *
 * - `budgetTokens: 48_000` (from `lib/config.ts`) — derived from measurement,
 *   not from the model's context window: a real 20-step run peaked near 79,000
 *   estimated tokens per request, so a window-sized ceiling would never have
 *   engaged. Token counts here are ESTIMATES (see `estimateTokens`), so some
 *   headroom is intentional.
 * - `keepRecentGroups: 6` (from `lib/config.ts`) — the model keeps the last few
 *   tool round-trips verbatim; older ones are progressively elided instead of
 *   dropped.
 * - `minElideChars: 400` — eliding a tiny tool result would cost more (in
 *   confusion and in the marker itself) than it saves, so short results stay.
 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetOptions = {
  budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
  keepRecentGroups: DEFAULT_CONTEXT_KEEP_GROUPS,
  minElideChars: DEFAULT_MIN_ELIDE_CHARS,
}

/** Prefix that marks content this module already elided (double-elision guard). */
const ELIDED_PREFIX = '[elided '
/** Longest argument hint kept in an elision marker. */
const MAX_HINT_CHARS = 80
/** Argument keys tried, in order, when building a short hint for an elision marker. */
const HINT_KEYS = ['path', 'command', 'pattern', 'file', 'dir', 'query', 'text', 'url', 'id'] as const

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when `content` was produced by this module (already elided). */
function isElided(content: string): boolean {
  return content.startsWith(ELIDED_PREFIX)
}

/** Flatten whitespace and cap a hint at `MAX_HINT_CHARS`. */
function clipHint(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_HINT_CHARS ? `${flat.slice(0, MAX_HINT_CHARS - 1)}…` : flat
}

/** Pick a short, human-meaningful hint out of a tool call's arguments. */
function describeArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  for (const key of HINT_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return clipHint(value)
  }
  return undefined
}

/** Build the marker that replaces an elided tool result's content. */
export function elisionMarker(toolName: string, chars: number, hint?: string): string {
  const tool = toolName.trim().length > 0 ? toolName.trim() : 'tool'
  const where = hint === undefined || hint.length === 0 ? '' : `: ${hint}`
  return `${ELIDED_PREFIX}${chars} chars from ${tool}${where} — call ${tool} again if you need it]`
}

/* -------------------------------------------------------------------------- */
/* Token estimation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Estimate the token cost of a string.
 *
 * HONEST APPROXIMATION — this is chars/4 plus a small constant, a rule of thumb
 * for English text and source code with a byte-pair tokenizer. It is NOT
 * tokenization: real counts differ by model, language and content, and can be
 * off by tens of percent. Treat every number here as an estimate and never as
 * an exact count. Empty input is exactly 0.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / 4) + 1
}

/** Per-message envelope cost (role marker, separators) in estimated tokens. */
const MESSAGE_OVERHEAD_TOKENS = 4

function estimateToolCallTokens(call: ToolCall): number {
  if (!isRecord(call)) return 0
  const name = typeof call.name === 'string' ? call.name : ''
  let args = ''
  try {
    args = JSON.stringify(call.args ?? {}) ?? ''
  } catch {
    args = ''
  }
  return estimateTokens(name) + estimateTokens(args)
}

/**
 * Estimate the token cost of a whole transcript: every message's content plus
 * the names/tool-call payloads plus a small per-message envelope constant.
 * Defensive: malformed entries contribute only their envelope, never a throw.
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  if (!Array.isArray(messages)) return 0
  let total = 0
  for (const message of messages) {
    total += MESSAGE_OVERHEAD_TOKENS
    if (!isRecord(message)) continue
    if (typeof message.content === 'string') total += estimateTokens(message.content)
    if (typeof message.name === 'string') total += estimateTokens(message.name)
    if (Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) total += estimateToolCallTokens(call)
    }
  }
  return total
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

function isAssistantWithToolCalls(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.role === 'assistant' &&
    Array.isArray(message.toolCalls) &&
    message.toolCalls.length > 0
  )
}

/**
 * Split a transcript into whole groups.
 *
 * A group is an `assistant` message carrying `toolCalls` plus every `tool`
 * message that immediately follows it; any other entry is its own group. Null /
 * malformed entries are preserved as their own single-message group so grouping
 * is a pure partition of the input, in order.
 */
export function groupMessages(messages: ChatMessage[]): ChatMessage[][] {
  const list = Array.isArray(messages) ? messages : []
  const groups: ChatMessage[][] = []
  let index = 0

  while (index < list.length) {
    const message = list[index]
    if (!isAssistantWithToolCalls(message)) {
      groups.push([message])
      index += 1
      continue
    }

    const group: ChatMessage[] = [message]
    let next = index + 1
    while (next < list.length && isRecord(list[next]) && (list[next] as ChatMessage).role === 'tool') {
      group.push(list[next])
      next += 1
    }
    groups.push(group)
    index = next
  }

  return groups
}

/* -------------------------------------------------------------------------- */
/* Option normalization                                                       */
/* -------------------------------------------------------------------------- */

/** Whole number >= 0, or `undefined` when the value is unusable. */
function cleanCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/** Whole number >= 1, or `undefined` when the value is unusable. */
function cleanBudget(value: unknown): number | undefined {
  const parsed = cleanCount(value)
  return parsed === undefined || parsed < 1 ? undefined : parsed
}

/** Merge a partial option set onto the documented defaults, ignoring junk. */
export function resolveContextBudget(
  options?: Partial<ContextBudgetOptions>,
): ContextBudgetOptions {
  const partial = isRecord(options) ? (options as Partial<ContextBudgetOptions>) : {}
  return {
    budgetTokens: cleanBudget(partial.budgetTokens) ?? DEFAULT_CONTEXT_BUDGET.budgetTokens,
    keepRecentGroups: cleanCount(partial.keepRecentGroups) ?? DEFAULT_CONTEXT_BUDGET.keepRecentGroups,
    minElideChars: cleanCount(partial.minElideChars) ?? DEFAULT_CONTEXT_BUDGET.minElideChars,
  }
}

/* -------------------------------------------------------------------------- */
/* The two-pass prune                                                         */
/* -------------------------------------------------------------------------- */

interface GroupState {
  messages: ChatMessage[]
  protected: boolean
  dropped: boolean
  tokens: number
}

/** Indexes of the groups that must never be elided and never be dropped. */
function protectedIndexes(groups: ChatMessage[][], keepRecentGroups: number): Set<number> {
  const protectedSet = new Set<number>()
  if (groups.length === 0) return protectedSet

  groups.forEach((group, index) => {
    if (group.some((message) => isRecord(message) && (message as ChatMessage).role === 'system')) {
      protectedSet.add(index)
    }
  })

  // The FIRST user message is the task itself.
  const firstUser = groups.findIndex((group) =>
    group.some((message) => isRecord(message) && (message as ChatMessage).role === 'user'),
  )
  if (firstUser >= 0) protectedSet.add(firstUser)

  // The most recent groups stay verbatim, and the final group is ALWAYS kept.
  const keep = Math.max(0, keepRecentGroups)
  for (let index = Math.max(0, groups.length - keep); index < groups.length; index++) {
    protectedSet.add(index)
  }
  protectedSet.add(groups.length - 1)

  return protectedSet
}

/** Map every `toolCallId` in a group to its originating call. */
function callsById(messages: ChatMessage[]): Map<string, ToolCall> {
  const byId = new Map<string, ToolCall>()
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.toolCalls)) continue
    for (const call of message.toolCalls) {
      if (isRecord(call) && typeof call.id === 'string') byId.set(call.id, call as ToolCall)
    }
  }
  return byId
}

/**
 * Elide one tool message's content when it is a long, not-yet-elided `tool`
 * result. Returns a CLONE carrying the marker, or `undefined` when the message
 * must stay verbatim (wrong role, missing content, short, already elided).
 */
function elideToolMessage(
  message: ChatMessage,
  calls: Map<string, ToolCall>,
  minElideChars: number,
): ChatMessage | undefined {
  if (!isRecord(message) || message.role !== 'tool') return undefined
  const content = message.content
  if (typeof content !== 'string') return undefined
  if (content.length <= minElideChars) return undefined
  if (isElided(content)) return undefined

  const call =
    typeof message.toolCallId === 'string' ? calls.get(message.toolCallId) : undefined
  const name =
    typeof message.name === 'string' && message.name.trim().length > 0
      ? message.name
      : typeof call?.name === 'string' && call.name.trim().length > 0
        ? call.name
        : 'tool'
  const hint = describeArgs(call?.args)

  return { ...message, content: elisionMarker(name, content.length, hint) }
}

function emptyStats(messages: ChatMessage[], groups: number): ContextStats {
  const tokens = estimateMessagesTokens(messages)
  const count = Array.isArray(messages) ? messages.length : 0
  return {
    pruned: false,
    originalTokens: tokens,
    finalTokens: tokens,
    originalMessages: count,
    finalMessages: count,
    elidedResults: 0,
    droppedGroups: 0,
    groups,
  }
}

/**
 * Apply the context budget to a transcript.
 *
 * Order of operations (exactly):
 *  1. estimate; if at or under budget, return the input UNCHANGED (`pruned:false`)
 *  2. group the messages and size each group
 *  3. mark protected groups (system prompt, first user task, last
 *     `keepRecentGroups` groups, and always the final group)
 *  4. PASS 1 — elide tool results in unprotected groups, oldest first, stopping
 *     the moment the estimate is at or under budget
 *  5. PASS 2 — drop WHOLE unprotected groups, oldest first, only if still over
 *  6. return a NEW array (unmodified messages are reused by reference; modified
 *     ones are clones) plus accurate stats
 *
 * Deterministic and idempotent: already-elided content is recognised by its
 * marker prefix and skipped, so a second run never double-elides. The input
 * array and its message objects are never mutated. It never throws: any internal
 * failure degrades to the input with `pruned: false`.
 */
export function applyContextBudget(
  messages: ChatMessage[],
  options?: Partial<ContextBudgetOptions>,
): { messages: ChatMessage[]; stats: ContextStats } {
  const input: ChatMessage[] = Array.isArray(messages) ? messages : []

  try {
    const config = resolveContextBudget(options)
    const groups = groupMessages(input)

    const originalTokens = estimateMessagesTokens(input)
    if (originalTokens <= config.budgetTokens) {
      return { messages: input, stats: emptyStats(input, groups.length) }
    }

    const protectedSet = protectedIndexes(groups, config.keepRecentGroups)
    const states: GroupState[] = groups.map((group, index) => ({
      messages: [...group],
      protected: protectedSet.has(index),
      dropped: false,
      tokens: estimateMessagesTokens(group),
    }))

    let currentTokens = originalTokens
    let elidedResults = 0
    let droppedGroups = 0

    // PASS 1 — elide long tool results, oldest unprotected group first.
    for (const state of states) {
      if (currentTokens <= config.budgetTokens) break
      if (state.protected || state.dropped) continue

      const calls = callsById(state.messages)
      for (let index = 0; index < state.messages.length; index++) {
        if (currentTokens <= config.budgetTokens) break
        const original = state.messages[index]
        const elided = elideToolMessage(original, calls, config.minElideChars)
        if (elided === undefined) continue

        const before = estimateTokens(original.content ?? '')
        const after = estimateTokens(elided.content ?? '')
        const saved = before - after
        state.messages[index] = elided
        state.tokens -= saved
        currentTokens -= saved
        elidedResults += 1
      }
    }

    // PASS 2 — drop whole unprotected groups (assistant toolCalls + all results).
    for (const state of states) {
      if (currentTokens <= config.budgetTokens) break
      if (state.protected || state.dropped) continue
      state.dropped = true
      currentTokens -= state.tokens
      droppedGroups += 1
    }

    const pruned = elidedResults > 0 || droppedGroups > 0
    if (!pruned) {
      return { messages: input, stats: emptyStats(input, groups.length) }
    }

    const finalMessages: ChatMessage[] = []
    for (const state of states) {
      if (state.dropped) continue
      for (const message of state.messages) finalMessages.push(message)
    }

    const stats: ContextStats = {
      pruned: true,
      originalTokens,
      finalTokens: estimateMessagesTokens(finalMessages),
      originalMessages: input.length,
      finalMessages: finalMessages.length,
      elidedResults,
      droppedGroups,
      groups: groups.length,
    }
    return { messages: finalMessages, stats }
  } catch {
    return { messages: input, stats: emptyStats(input, groupMessages(input).length) }
  }
}
