/**
 * Unit tests for the append-only usage ledger ([`lib/usage.ts`](../lib/usage.ts)).
 *
 * Every test uses a temp `root` (or `ZOO_USAGE_DIR`) so the repo's real `.zoo/`
 * is never touched. The suite asserts the two invariants that matter most for a
 * local telemetry store: it never throws, and a corrupt line degrades to a
 * counted skip rather than a failed read.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DEFAULT_PRICING,
  estimateCostUsd,
  getUsageDir,
  getUsageFile,
  loadPricing,
  makeRunId,
  pricingFor,
  readUsage,
  recordUsage,
  summarizeUsage,
  type ModelPricing,
  type UsageEntry,
} from '../lib/usage.js'

const temps: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zoocode-usage-'))
  temps.push(dir)
  return dir
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** Build a complete UsageEntry with sane defaults. */
function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  const promptTokens = overrides.promptTokens ?? 100
  const completionTokens = overrides.completionTokens ?? 50
  const built: UsageEntry = {
    ts: overrides.ts ?? '2026-01-01T00:00:00.000Z',
    kind: overrides.kind ?? 'agent',
    model: overrides.model ?? 'deepseek-chat',
    runId: overrides.runId ?? 'run-1',
    steps: overrides.steps ?? 1,
    promptTokens,
    completionTokens,
    totalTokens: overrides.totalTokens ?? promptTokens + completionTokens,
    durationMs: overrides.durationMs ?? 1000,
    ok: overrides.ok ?? true,
  }
  if (overrides.label !== undefined) built.label = overrides.label
  return built
}

const norm = (p: string): string => p.split('\\').join('/')

describe('paths', () => {
  it('resolves <root>/.zoo and the usage.jsonl ledger inside it', () => {
    const dir = tempDir()
    expect(norm(getUsageDir(dir))).toBe(`${norm(dir)}/.zoo`)
    expect(norm(getUsageFile(dir))).toBe(`${norm(dir)}/.zoo/usage.jsonl`)
  })

  it('honors the ZOO_USAGE_DIR env var', () => {
    const dir = tempDir()
    const prev = process.env.ZOO_USAGE_DIR
    process.env.ZOO_USAGE_DIR = dir
    try {
      expect(norm(getUsageDir())).toBe(`${norm(dir)}/.zoo`)
    } finally {
      if (prev === undefined) delete process.env.ZOO_USAGE_DIR
      else process.env.ZOO_USAGE_DIR = prev
    }
  })
})

describe('recordUsage / readUsage round-trip', () => {
  it('appends entries and reads them back in order', () => {
    const dir = tempDir()
    const first = entry({ runId: 'r1' })
    const second = entry({ runId: 'r2', ts: '2026-01-02T00:00:00.000Z' })

    expect(recordUsage(first, dir).ok).toBe(true)
    expect(recordUsage(second, dir).ok).toBe(true)
    expect(existsSync(join(dir, '.zoo', 'usage.jsonl'))).toBe(true)

    const read = readUsage(dir)
    expect(read.ok).toBe(true)
    expect(read.skippedLines).toBe(0)
    expect(read.data).toEqual([first, second])
  })

  it('returns an empty list (not an error) when the ledger does not exist', () => {
    const dir = tempDir()
    const read = readUsage(dir)
    expect(read.ok).toBe(true)
    expect(read.data).toEqual([])
    expect(read.skippedLines).toBe(0)
  })
})

describe('readUsage robustness', () => {
  it('skips and counts corrupt / misshaped lines', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.zoo'), { recursive: true })
    const valid = entry({ runId: 'good' })
    writeFileSync(
      join(dir, '.zoo', 'usage.jsonl'),
      [
        JSON.stringify(valid),
        'this is not json',
        '{"foo":1}', // valid JSON, but no ts/model
        '',
        '[1,2,3]',
        JSON.stringify(entry({ runId: 'good-2', ts: '2026-01-02T00:00:00.000Z' })),
        '',
      ].join('\n'),
      'utf-8',
    )

    const read = readUsage(dir)
    expect(read.ok).toBe(true)
    expect(read.data).toHaveLength(2)
    expect(read.skippedLines).toBe(3)
  })

  it('reports { ok:false } without throwing when the ledger path is a directory', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.zoo', 'usage.jsonl'), { recursive: true })
    let read: ReturnType<typeof readUsage> | undefined
    expect(() => {
      read = readUsage(dir)
    }).not.toThrow()
    expect(read?.ok).toBe(false)
    expect(read?.data).toEqual([])
  })

  it('never throws when `.zoo` is a file instead of a directory', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '.zoo'), 'not a directory', 'utf-8')

    let recorded: ReturnType<typeof recordUsage> | undefined
    let read: ReturnType<typeof readUsage> | undefined
    expect(() => {
      recorded = recordUsage(entry(), dir)
      read = readUsage(dir)
    }).not.toThrow()

    // The write fails cleanly (no directory to write into)…
    expect(recorded?.ok).toBe(false)
    expect(recorded?.error).toBeTruthy()
    // …while the read degrades to "nothing recorded yet".
    expect(read?.ok).toBe(true)
    expect(read?.data).toEqual([])
  })
})

describe('summarizeUsage', () => {
  const now = new Date('2026-01-07T00:00:00.000Z')
  const entries: UsageEntry[] = [
    entry({
      ts: '2026-01-05T10:00:00.000Z',
      model: 'deepseek-chat',
      steps: 2,
      promptTokens: 1_000_000,
      completionTokens: 0,
      durationMs: 1000,
    }),
    entry({
      ts: '2026-01-05T12:00:00.000Z',
      model: 'deepseek-chat',
      steps: 1,
      promptTokens: 0,
      completionTokens: 1_000_000,
      durationMs: 2000,
    }),
    entry({
      ts: '2026-01-06T00:00:00.000Z',
      model: 'made-up-model',
      steps: 3,
      promptTokens: 500,
      completionTokens: 500,
      durationMs: 3000,
    }),
  ]

  it('aggregates overall, per-model and per-day totals', () => {
    const summary = summarizeUsage(entries, { now })

    expect(summary.entries).toBe(3)
    expect(summary.overall).toEqual({
      runs: 3,
      steps: 6,
      promptTokens: 1_000_500,
      completionTokens: 1_000_500,
      totalTokens: 2_001_000,
      estimatedCostUsd: 1.37, // 0.27 + 1.10 (+0 for the unknown model)
      durationMs: 6000,
    })

    // Per model.
    expect(summary.byModel['deepseek-chat'].runs).toBe(2)
    expect(summary.byModel['deepseek-chat'].totalTokens).toBe(2_000_000)
    expect(summary.byModel['deepseek-chat'].estimatedCostUsd).toBe(1.37)
    expect(summary.byModel['made-up-model'].runs).toBe(1)

    // Per day (sorted ascending).
    expect(Object.keys(summary.byDay)).toEqual(['2026-01-05', '2026-01-06'])
    expect(summary.byDay['2026-01-05'].runs).toBe(2)
    expect(summary.byDay['2026-01-06'].runs).toBe(1)

    // Window bounds + the honesty list.
    expect(summary.firstTs).toBe('2026-01-05T10:00:00.000Z')
    expect(summary.lastTs).toBe('2026-01-06T00:00:00.000Z')
    expect(summary.unpricedModels).toEqual(['made-up-model'])
    expect(summary.skippedLines).toBe(0)
  })

  it('filters to the last N days using the injected `now`', () => {
    const nowOneDay = new Date('2026-01-06T12:00:00.000Z')
    const summary = summarizeUsage(entries, { days: 1, now: nowOneDay })

    expect(summary.entries).toBe(2) // excludes the 2026-01-05T10:00 entry
    expect(summary.overall.runs).toBe(2)
    expect(summary.overall.totalTokens).toBe(1_001_000)
    expect(Object.keys(summary.byDay)).toEqual(['2026-01-05', '2026-01-06'])
  })

  it('accepts an explicit pricing table', () => {
    const pricing: ModelPricing[] = [
      { model: 'deepseek-chat', promptUsdPerMillion: 1, completionUsdPerMillion: 2 },
    ]
    const summary = summarizeUsage(entries, { now, pricing })
    // deepseek-chat: 1M prompt * $1/M + 1M completion * $2/M = $3.
    expect(summary.byModel['deepseek-chat'].estimatedCostUsd).toBe(3)
  })

  it('never throws on an empty list', () => {
    let summary: ReturnType<typeof summarizeUsage> | undefined
    expect(() => {
      summary = summarizeUsage([])
    }).not.toThrow()
    expect(summary?.entries).toBe(0)
    expect(summary?.overall.runs).toBe(0)
  })
})

describe('pricing', () => {
  it('computes cost for a known pricing row', () => {
    const pricing: ModelPricing[] = [
      { model: 'x', promptUsdPerMillion: 1, completionUsdPerMillion: 2 },
    ]
    expect(estimateCostUsd('x', 1_000_000, 500_000, pricing)).toBe(2)
    expect(estimateCostUsd('x', 0, 0, pricing)).toBe(0)
  })

  it('reports cost 0 for an unknown model AND names it as unpriced', () => {
    expect(estimateCostUsd('no-such-model', 1_000_000, 1_000_000)).toBe(0)
    const summary = summarizeUsage([entry({ model: 'no-such-model' })])
    expect(summary.overall.estimatedCostUsd).toBe(0)
    expect(summary.unpricedModels).toContain('no-such-model')
  })

  it('pricingFor prefers an explicit table over DEFAULT_PRICING', () => {
    expect(pricingFor('deepseek-chat')).toBeDefined()
    const override: ModelPricing[] = [
      { model: 'deepseek-chat', promptUsdPerMillion: 42, completionUsdPerMillion: 0 },
    ]
    expect(pricingFor('deepseek-chat', override)?.promptUsdPerMillion).toBe(42)
    expect(estimateCostUsd('deepseek-chat', 1_000_000, 0, override)).toBe(42)
  })

  it('loadPricing merges .zoo/pricing.json over the defaults', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.zoo'), { recursive: true })
    writeFileSync(
      join(dir, '.zoo', 'pricing.json'),
      JSON.stringify({
        models: [
          { model: 'deepseek-chat', promptUsdPerMillion: 9, completionUsdPerMillion: 9 },
          { model: 'brand-new-model', promptUsdPerMillion: 1, completionUsdPerMillion: 1 },
        ],
      }),
      'utf-8',
    )

    const loaded = loadPricing(dir)
    expect(loaded.ok).toBe(true)
    expect(pricingFor('deepseek-chat', loaded.data)?.promptUsdPerMillion).toBe(9)
    expect(pricingFor('brand-new-model', loaded.data)?.completionUsdPerMillion).toBe(1)
    // A default row that was not overridden is still present.
    expect(pricingFor('deepseek-reasoner', loaded.data)).toBeDefined()
  })

  it('loadPricing falls back to DEFAULT_PRICING on a missing or corrupt file', () => {
    const dir = tempDir()
    expect(loadPricing(dir).ok).toBe(true)
    expect(loadPricing(dir).data).toHaveLength(DEFAULT_PRICING.length)

    mkdirSync(join(dir, '.zoo'), { recursive: true })
    writeFileSync(join(dir, '.zoo', 'pricing.json'), '{ not json', 'utf-8')
    const corrupt = loadPricing(dir)
    expect(corrupt.ok).toBe(false)
    expect(corrupt.data).toHaveLength(DEFAULT_PRICING.length)
  })
})

describe('makeRunId', () => {
  it('produces unique ids across many calls', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 2000; index++) ids.add(makeRunId())
    expect(ids.size).toBe(2000)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
  })
})
