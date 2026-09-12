/**
 * `lib/context-budget.ts` — the two-pass context pruner.
 *
 * The single most important property tested here is the OpenAI/DeepSeek pairing
 * invariant: for every assistant message carrying `toolCalls`, the messages that
 * immediately follow it must answer EVERY `toolCallId` with a `tool` result and
 * must not interleave any other message type. Every pruning scenario re-checks
 * it (see `pairingViolations`).
 */

import { describe, it, expect } from 'vitest'
import {
  applyContextBudget,
  DEFAULT_CONTEXT_BUDGET,
  estimateMessagesTokens,
  estimateTokens,
  groupMessages,
} from '../lib/context-budget.js'
import type { ChatMessage } from '../lib/types.js'

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Return one string per assistant-with-toolCalls message that is NOT correctly
 * answered by the immediately following `tool` messages. An empty array means
 * the transcript is wire-valid for DeepSeek.
 */
function pairingViolations(messages: ChatMessage[]): string[] {
  const violations: string[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as ChatMessage | null | undefined
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

interface TranscriptOptions {
  /** Number of assistant-toolCalls + tool-result round trips. */
  groups?: number
  /** Characters in each tool result content. */
  resultChars?: number
  /** Characters in the system prompt. */
  systemChars?: number
}

/**
 * A synthetic, deterministic "long transcript": one system prompt, the user
 * task, N tool round trips (read_file with a `path` arg), and a final assistant
 * reply. Nothing here is random, so every number below is reproducible.
 */
function longTranscript(options: TranscriptOptions = {}): ChatMessage[] {
  const groups = options.groups ?? 6
  const resultChars = options.resultChars ?? 4_000
  const payload = `0123456789`.repeat(Math.ceil(resultChars / 10) + 1)

  const messages: ChatMessage[] = [
    { role: 'system', content: `S${'p'.repeat((options.systemChars ?? 200) - 1)}` },
    { role: 'user', content: 'Read every file and summarize it.' },
  ]

  for (let index = 0; index < groups; index++) {
    const id = `call-${index}`
    messages.push({
      role: 'assistant',
      content: null,
      toolCalls: [{ id, name: 'read_file', args: { path: `lib/file-${index}.ts` } }],
    })
    messages.push({
      role: 'tool',
      toolCallId: id,
      name: 'read_file',
      content: `// lib/file-${index}.ts\n${payload.slice(0, resultChars)}`,
    })
  }

  messages.push({ role: 'assistant', content: 'All files summarized.' })
  return messages
}

function toolContents(messages: ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.content ?? '')
}

/* -------------------------------------------------------------------------- */
/* (i) Token estimation sanity                                                */
/* -------------------------------------------------------------------------- */

describe('estimateTokens / estimateMessagesTokens', () => {
  it('is zero for empty input', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateMessagesTokens([])).toBe(0)
  })

  it('is monotonic in the amount of text', () => {
    expect(estimateTokens('a')).toBeLessThanOrEqual(estimateTokens('aaaa'))
    expect(estimateTokens('aaaa')).toBeLessThan(estimateTokens('a'.repeat(4_000)))
    expect(estimateMessagesTokens(longTranscript({ groups: 2 }))).toBeLessThan(
      estimateMessagesTokens(longTranscript({ groups: 4 })),
    )
  })

  it('assumes roughly four characters per token', () => {
    // 400 chars -> ceil(400/4)+1 = 101, an estimate, not an exact count.
    expect(estimateTokens('x'.repeat(400))).toBe(101)
  })

  it('never throws on malformed input', () => {
    expect(() => estimateMessagesTokens(null as unknown as ChatMessage[])).not.toThrow()
    expect(estimateMessagesTokens(null as unknown as ChatMessage[])).toBe(0)
    expect(() =>
      estimateMessagesTokens([null as unknown as ChatMessage, { role: 'tool' } as ChatMessage]),
    ).not.toThrow()
  })
})

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

describe('groupMessages', () => {
  it('keeps an assistant toolCalls message with all of its tool results', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'a', name: 'read_file', args: { path: 'a.ts' } },
          { id: 'b', name: 'read_file', args: { path: 'b.ts' } },
        ],
      },
      { role: 'tool', toolCallId: 'a', name: 'read_file', content: 'A' },
      { role: 'tool', toolCallId: 'b', name: 'read_file', content: 'B' },
      { role: 'assistant', content: 'done' },
    ]

    const groups = groupMessages(messages)

    expect(groups).toHaveLength(4)
    expect(groups[0]).toHaveLength(1)
    expect(groups[1]).toHaveLength(1)
    expect(groups[2]).toHaveLength(3)
    expect(groups[2].map((message) => message.role)).toEqual(['assistant', 'tool', 'tool'])
    expect(groups[3]).toHaveLength(1)
  })

  it('partitions every message exactly once, in order', () => {
    const messages = longTranscript({ groups: 3 })
    const flattened = groupMessages(messages).flat()
    expect(flattened).toHaveLength(messages.length)
    expect(flattened).toEqual(messages)
  })

  it('treats an orphan tool message as its own group and survives null entries', () => {
    const messages = [null as unknown as ChatMessage, { role: 'tool', content: 'x' } as ChatMessage]
    const groups = groupMessages(messages)
    expect(groups).toHaveLength(2)
    expect(groups[1]).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* (a) Under budget                                                           */
/* -------------------------------------------------------------------------- */

describe('applyContextBudget — under budget', () => {
  it('(a) returns the input unchanged with pruned:false', () => {
    const messages = longTranscript({ groups: 4 })
    const out = applyContextBudget(messages, { budgetTokens: 1_000_000 })

    expect(out.stats.pruned).toBe(false)
    expect(out.messages).toBe(messages) // same array, not a gratuitous clone
    expect(out.stats.originalTokens).toBe(out.stats.finalTokens)
    expect(out.stats.originalMessages).toBe(messages.length)
    expect(out.stats.finalMessages).toBe(messages.length)
    expect(out.stats.elidedResults).toBe(0)
    expect(out.stats.droppedGroups).toBe(0)
    expect(out.stats.groups).toBe(groupMessages(messages).length)
    expect(pairingViolations(out.messages)).toEqual([])
  })

  it('uses the documented defaults when no options are given', () => {
    const messages = longTranscript({ groups: 2 })
    // Well under the default ceiling, so nothing happens.
    const out = applyContextBudget(messages)
    expect(out.stats.pruned).toBe(false)
    expect(DEFAULT_CONTEXT_BUDGET.budgetTokens).toBe(48_000)
    expect(DEFAULT_CONTEXT_BUDGET.keepRecentGroups).toBe(6)
    expect(DEFAULT_CONTEXT_BUDGET.minElideChars).toBe(400)
  })
})

/* -------------------------------------------------------------------------- */
/* (b) Over budget — elide oldest first                                       */
/* -------------------------------------------------------------------------- */

describe('applyContextBudget — over budget', () => {
  it('(b) elides the oldest unprotected tool results first, and measures the reduction', () => {
    const messages = longTranscript({ groups: 8, resultChars: 4_000 })
    const originalTokens = estimateMessagesTokens(messages)
    const budgetTokens = originalTokens - 2_500

    const out = applyContextBudget(messages, { budgetTokens, keepRecentGroups: 2 })

    expect(out.stats.pruned).toBe(true)
    expect(out.stats.originalTokens).toBe(originalTokens)
    expect(out.stats.finalTokens).toBeLessThan(out.stats.originalTokens)
    expect(out.stats.finalTokens).toBeLessThanOrEqual(budgetTokens)
    expect(out.stats.elidedResults).toBeGreaterThan(0)
    // Elision alone was enough here — nothing had to be dropped.
    expect(out.stats.droppedGroups).toBe(0)
    expect(out.stats.finalMessages).toBe(out.stats.originalMessages)

    const contents = toolContents(out.messages)
    const elidedFlags = contents.map((content) => content.startsWith('[elided '))

    // Oldest first: the elided flags form a prefix (all true, then all false).
    expect(elidedFlags[0]).toBe(true)
    expect(elidedFlags).toEqual([...elidedFlags].sort((a, b) => Number(b) - Number(a)))
    expect(elidedFlags.filter(Boolean)).toHaveLength(out.stats.elidedResults)

    // The marker is descriptive: tool name + the recovering argument hint.
    expect(contents[0]).toContain('[elided')
    expect(contents[0]).toContain('read_file')
    expect(contents[0]).toContain('lib/file-0.ts')
    expect(contents[0]).toContain('call read_file again if you need it')

    expect(pairingViolations(out.messages)).toEqual([])
  })

  it('measures the reduction on a 30-group synthetic transcript', () => {
    // A deliberately long transcript: 30 tool round trips of 4,000 characters
    // each (~2,000 estimated tokens per result) plus a system prompt and a task.
    const messages = longTranscript({ groups: 30, resultChars: 4_000, systemChars: 300 })
    const originalTokens = estimateMessagesTokens(messages)
    const budgetTokens = 4_000

    const out = applyContextBudget(messages, { budgetTokens, keepRecentGroups: 4 })

    // Measured before/after — this is the evidence that the loop self-bounds.
    // eslint-disable-next-line no-console
    console.log(
      `[measure] ${originalTokens} -> ${out.stats.finalTokens} est. tokens over ` +
        `${messages.length} -> ${out.messages.length} messages ` +
        `(${out.stats.elidedResults} elided, ${out.stats.droppedGroups} dropped, ` +
        `${out.stats.groups} groups)`,
    )

    expect(out.stats.pruned).toBe(true)
    expect(out.stats.originalTokens).toBe(originalTokens)
    expect(out.stats.finalTokens).toBeLessThanOrEqual(budgetTokens)
    expect(out.stats.finalTokens).toBeLessThan(originalTokens / 3)
    expect(out.stats.originalMessages).toBe(messages.length)
    expect(out.stats.finalMessages).toBeLessThan(messages.length)
    expect(out.stats.droppedGroups).toBeGreaterThan(0)
    expect(out.stats.elidedResults).toBeGreaterThan(0)
    expect(pairingViolations(out.messages)).toEqual([])
  })

  it('respects minElideChars (short results are never elided)', () => {
    const messages = longTranscript({ groups: 4, resultChars: 5_000 })
    const originalTokens = estimateMessagesTokens(messages)
    const budgetTokens = originalTokens - 1

    const out = applyContextBudget(messages, {
      budgetTokens,
      keepRecentGroups: 1,
      minElideChars: 1_000_000,
    })

    expect(out.stats.elidedResults).toBe(0)
    const contents = toolContents(out.messages)
    expect(contents.every((content) => !content.startsWith('[elided '))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* (d) Protected content survives                                             */
/* -------------------------------------------------------------------------- */

describe('applyContextBudget — protection', () => {
  it('(d) never touches the system prompt, the first user task, or the recent groups', () => {
    const messages = longTranscript({ groups: 8, resultChars: 4_000, systemChars: 300 })
    const originalTokens = estimateMessagesTokens(messages)

    const out = applyContextBudget(messages, {
      budgetTokens: originalTokens - 3_500,
      keepRecentGroups: 2,
    })

    expect(out.stats.pruned).toBe(true)

    // The system prompt (group 0) and the first user task (group 1) survive verbatim.
    expect(out.messages[0]).toEqual(messages[0])
    expect(out.messages[1]).toEqual(messages[1])

    // The last `keepRecentGroups` groups survive verbatim as well.
    const tail = out.messages.slice(-4)
    expect(tail).toEqual(messages.slice(-4))

    expect(pairingViolations(out.messages)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* (e) Heavily over budget — whole groups are dropped                         */
/* -------------------------------------------------------------------------- */

describe('applyContextBudget — pass 2 drops whole groups', () => {
  it('(e) drops whole unprotected groups while preserving the invariant and the protected ones', () => {
    const messages = longTranscript({ groups: 8, resultChars: 4_000 })
    const out = applyContextBudget(messages, { budgetTokens: 50, keepRecentGroups: 1 })

    expect(out.stats.pruned).toBe(true)
    expect(out.stats.droppedGroups).toBeGreaterThan(0)
    expect(out.stats.finalMessages).toBeLessThan(out.stats.originalMessages)

    // Protected content survived.
    expect(out.messages[0]).toEqual(messages[0]) // system
    expect(out.messages[1]).toEqual(messages[1]) // first user task

    // Every surviving assistant-toolCalls message is still fully answered, and a
    // drop removed the assistant call together with ALL of its results.
    expect(pairingViolations(out.messages)).toEqual([])
    const droppedToolResults = messages.length - out.messages.length
    expect(droppedToolResults % 2).toBe(0) // whole call+result pairs only

    // The final group (assistant reply) is always kept.
    expect(out.messages.at(-1)).toEqual(messages.at(-1))
  })
})

/* -------------------------------------------------------------------------- */
/* (f) Idempotence                                                            */
/* -------------------------------------------------------------------------- */

describe('applyContextBudget — idempotence', () => {
  it('(f) applying it twice does not double-elide', () => {
    const messages = longTranscript({ groups: 8, resultChars: 4_000 })
    const budget = { budgetTokens: estimateMessagesTokens(messages) - 2_500, keepRecentGroups: 2 }

    const first = applyContextBudget(messages, budget)
    expect(first.stats.pruned).toBe(true)

    const second = applyContextBudget(first.messages, budget)

    expect(second.stats.pruned).toBe(false)
    expect(second.messages).toEqual(first.messages)
    expect(second.stats.elidedResults).toBe(0)
    // Exactly one marker per elided result — no nested markers.
    for (const content of toolContents(second.messages)) {
      expect(content.split('[elided ').length - 1).toBeLessThanOrEqual(1)
    }
  })

  it('is idempotent even when it remains over budget after dropping everything it may', () => {
    const messages = longTranscript({ groups: 6, resultChars: 4_000 })
    const budget = { budgetTokens: 10, keepRecentGroups: 1 }

    const first = applyContextBudget(messages, budget)
    const second = applyContextBudget(first.messages, budget)

    expect(second.stats.pruned).toBe(false)
    expect(second.messages).toEqual(first.messages)
  })
})

/* -------------------------------------------------------------------------- */
/* (g) The input is never mutated                                             */
/* -------------------------------------------------------------------------- */

describe('applyContextBudget — non-mutation', () => {
  it('(g) leaves the input array and its message objects untouched', () => {
    const messages = longTranscript({ groups: 8, resultChars: 4_000 })
    const snapshot = JSON.stringify(messages)
    const ids = messages.map((message) => message)

    const out = applyContextBudget(messages, {
      budgetTokens: estimateMessagesTokens(messages) - 3_500,
      keepRecentGroups: 2,
    })

    expect(out.stats.pruned).toBe(true)
    expect(JSON.stringify(messages)).toBe(snapshot)
    expect(messages).toHaveLength(ids.length)
    messages.forEach((message, index) => expect(message).toBe(ids[index]))

    // Unmodified messages are reused by reference; only elided ones are clones.
    expect(out.messages).not.toBe(messages)
    expect(out.messages[0]).toBe(messages[0])
    const firstTool = out.messages.find((message) => message.role === 'tool') as ChatMessage
    expect(firstTool).not.toBe(messages.find((message) => message.role === 'tool'))
    expect(firstTool.content).toContain('[elided ')
  })
})

/* -------------------------------------------------------------------------- */
/* (h) Malformed input never throws                                           */
/* -------------------------------------------------------------------------- */

describe('applyContextBudget — robustness', () => {
  it('(h) never throws on null entries, orphan tool messages or missing content', () => {
    const malformed: ChatMessage[] = [
      { role: 'system', content: 'S'.repeat(2_000) },
      null as unknown as ChatMessage,
      { role: 'user', content: 'task' },
      { role: 'tool', toolCallId: 'orphan', content: 'R'.repeat(2_000) },
      { role: 'assistant', content: null },
      { role: 'tool' } as ChatMessage,
      { content: 'no role' } as ChatMessage,
    ]
    const snapshot = JSON.stringify(malformed)

    let out: { messages: ChatMessage[]; stats: unknown } | undefined
    expect(() => {
      out = applyContextBudget(malformed, { budgetTokens: 10, keepRecentGroups: 0 })
    }).not.toThrow()

    expect(out).toBeDefined()
    expect(JSON.stringify(malformed)).toBe(snapshot)
    expect(pairingViolations(out?.messages ?? [])).toEqual([])
  })

  it('(h) returns a safe result for a non-array transcript', () => {
    expect(() => applyContextBudget(null as unknown as ChatMessage[])).not.toThrow()
    const out = applyContextBudget(null as unknown as ChatMessage[])
    expect(out.messages).toEqual([])
    expect(out.stats.pruned).toBe(false)
  })

  it('(h) falls back to the defaults for junk option values', () => {
    const messages = longTranscript({ groups: 2 })
    const out = applyContextBudget(messages, {
      budgetTokens: Number.NaN,
      keepRecentGroups: -5,
      minElideChars: Number.POSITIVE_INFINITY,
    })
    expect(out.stats.pruned).toBe(false)
    expect(out.messages).toBe(messages)
  })
})
