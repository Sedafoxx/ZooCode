/**
 * Usage & cost tracking for the homegrown harness.
 *
 * An **append-only** ledger at `<root>/.zoo/usage.jsonl` (one JSON object per
 * line) records what each agent / chat / parallel run actually cost in tokens.
 * The ledger is local telemetry: it is gitignored, never written by tests, and
 * never required for a run to succeed.
 *
 * Design mirrors [`lib/context.ts`](lib/context.ts):
 *   - repo root resolved from this module's own location (`import.meta.url`)
 *   - every public function accepts an optional `root` (or `ZOO_USAGE_DIR`) so
 *     tests can redirect the store into a temp dir
 *   - the shared result convention `{ ok, data?, error? }`, never throwing
 *
 * Pricing honesty: token *counts* come from the API and are facts; the money
 * figure is a **configurable estimate**, never billing. See `DEFAULT_PRICING`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface UsageEntry {
  ts: string // ISO timestamp
  kind: 'agent' | 'chat' | 'parallel'
  model: string
  runId: string
  steps: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
  ok: boolean
  /** Short (<= 80 char) description of the task; never contain secrets. */
  label?: string
}

export interface UsageTotals {
  runs: number
  steps: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimatedCostUsd: number
  durationMs: number
}

export interface UsageSummary {
  overall: UsageTotals
  byModel: Record<string, UsageTotals>
  byDay: Record<string, UsageTotals> // 'YYYY-MM-DD'
  entries: number
  skippedLines: number // corrupt/unparseable lines ignored
  /** Models that had token usage but no known price — cost is reported as 0. */
  unpricedModels: string[]
  firstTs?: string
  lastTs?: string
}

export interface ModelPricing {
  model: string
  promptUsdPerMillion: number
  completionUsdPerMillion: number
}

/* -------------------------------------------------------------------------- */
/* Pricing (configurable, clearly estimated)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Seed prices for the models this repo can actually reach.
 *
 * ASSUMPTIONS (all of them may be STALE — DeepSeek changes prices):
 *   - `deepseek-chat`  : ~$0.27 / M input tokens, ~$1.10 / M output tokens.
 *   - `deepseek-reasoner`: ~$0.55 / M input tokens, ~$2.19 / M output tokens.
 * These are the published *standard* (cache-miss) list prices as of early 2025,
 * rounded, and are provided only so the estimate is in the right ballpark.
 *
 * This is NOT billing. The authoritative number is DeepSeek's own dashboard /
 * invoice. Override any row in `<root>/.zoo/pricing.json`:
 *
 *   { "models": [ { "model": "deepseek-chat",
 *                   "promptUsdPerMillion": 0.27,
 *                   "completionUsdPerMillion": 1.10 } ] }
 */
export const DEFAULT_PRICING: ModelPricing[] = [
  { model: 'deepseek-chat', promptUsdPerMillion: 0.27, completionUsdPerMillion: 1.1 },
  { model: 'deepseek-reasoner', promptUsdPerMillion: 0.55, completionUsdPerMillion: 2.19 },
]

const UsageFileName = 'usage.jsonl'
const PricingFileName = 'pricing.json'

/* -------------------------------------------------------------------------- */
/* Root + path resolution                                                     */
/* -------------------------------------------------------------------------- */

/** Repo root resolved from this module's own location (lib/ is one level down). */
const RepoRoot = fileURLToPath(new URL('../', import.meta.url))

/** Resolve the base directory for the ledger: explicit root > env var > repo root. */
function resolveRoot(root?: string): string {
  if (root) return root
  const env = process.env.ZOO_USAGE_DIR
  if (env) return env
  return RepoRoot
}

/** The directory that holds the ledger, `<resolvedRoot>/.zoo`. */
export function getUsageDir(root?: string): string {
  return join(resolveRoot(root), '.zoo')
}

/** Absolute path of the append-only ledger file. */
export function getUsageFile(root?: string): string {
  return join(getUsageDir(root), UsageFileName)
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* -------------------------------------------------------------------------- */
/* Ledger writes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Append one entry to `<root>/.zoo/usage.jsonl`.
 *
 * The append uses `appendFileSync(…, { flag: 'a' })`, which is deliberately
 * crash-safe **here**: the ledger is append-only, so an interrupted write can at
 * worst leave a truncated FINAL line (which `readUsage` skips and counts) — it can
 * never corrupt already-persisted entries the way an in-place rewrite could. That
 * is why the write-temp-then-rename dance `lib/context.ts` needs for its single
 * JSON document is not required for a JSONL log.
 *
 * Never throws: a `.zoo` path that is a file (or any other FS error) is reported
 * as `{ ok: false, error }`.
 */
export function recordUsage(
  entry: UsageEntry,
  root?: string,
): { ok: boolean; data?: UsageEntry; error?: string } {
  try {
    const dir = getUsageDir(root)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, UsageFileName), `${JSON.stringify(entry)}\n`, 'utf-8')
    return { ok: true, data: entry }
  } catch (err) {
    return { ok: false, error: `Failed to record usage: ${errorMessage(err)}` }
  }
}

/* -------------------------------------------------------------------------- */
/* Ledger reads                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Validate one parsed JSONL line into a `UsageEntry`.
 *
 * A line is accepted when it is an object with a non-empty string `ts` and a
 * string `model`; `kind` falls back to `'agent'` and numeric fields to 0. Anything
 * else is `undefined` and the caller counts it as a skipped line.
 */
function coerceEntry(value: unknown): UsageEntry | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.ts !== 'string' || value.ts.length === 0) return undefined
  if (typeof value.model !== 'string' || value.model.length === 0) return undefined

  const kind: UsageEntry['kind'] =
    value.kind === 'chat' || value.kind === 'parallel' ? value.kind : 'agent'

  const promptTokens = asNumber(value.promptTokens)
  const completionTokens = asNumber(value.completionTokens)
  const entry: UsageEntry = {
    ts: value.ts,
    kind,
    model: value.model,
    runId: typeof value.runId === 'string' ? value.runId : '',
    steps: asNumber(value.steps),
    promptTokens,
    completionTokens,
    totalTokens: asNumber(value.totalTokens, promptTokens + completionTokens),
    durationMs: asNumber(value.durationMs),
    ok: value.ok !== false,
  }
  if (typeof value.label === 'string') entry.label = value.label
  return entry
}

/**
 * Read the whole ledger. Never throws.
 *
 *  - missing file            → `{ ok: true, data: [] }`
 *  - corrupt/garbage lines   → skipped and counted in `skippedLines`
 *  - unreadable path (e.g. `.zoo/usage.jsonl` is a directory) → `{ ok: false }`
 */
export function readUsage(
  root?: string,
): { ok: boolean; data?: UsageEntry[]; skippedLines: number; error?: string } {
  try {
    const file = getUsageFile(root)
    if (!existsSync(file)) return { ok: true, data: [], skippedLines: 0 }

    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch (err) {
      return {
        ok: false,
        data: [],
        skippedLines: 0,
        error: `Failed to read usage ledger: ${errorMessage(err)}`,
      }
    }

    const entries: UsageEntry[] = []
    let skippedLines = 0
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        skippedLines += 1
        continue
      }
      const entry = coerceEntry(parsed)
      if (entry === undefined) {
        skippedLines += 1
        continue
      }
      entries.push(entry)
    }

    return { ok: true, data: entries, skippedLines }
  } catch (err) {
    return {
      ok: false,
      data: [],
      skippedLines: 0,
      error: `Failed to read usage ledger: ${errorMessage(err)}`,
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Pricing lookup                                                             */
/* -------------------------------------------------------------------------- */

/** Case-insensitive price lookup; `pricing` defaults to {@link DEFAULT_PRICING}. */
export function pricingFor(model: string, pricing?: ModelPricing[]): ModelPricing | undefined {
  const table = pricing ?? DEFAULT_PRICING
  const wanted = model.trim().toLowerCase()
  for (const row of table) {
    if (row.model.trim().toLowerCase() === wanted) return row
  }
  return undefined
}

/**
 * Estimated USD for one run. An **estimate**, not billing.
 *
 * An unknown model costs `0` here — callers must consult `unpricedModels` on the
 * summary rather than reading that zero as "free".
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  pricing?: ModelPricing[],
): number {
  const row = pricingFor(model, pricing)
  if (row === undefined) return 0
  const prompt = asNumber(promptTokens)
  const completion = asNumber(completionTokens)
  const usd =
    (prompt / 1_000_000) * row.promptUsdPerMillion +
    (completion / 1_000_000) * row.completionUsdPerMillion
  return roundUsd(usd)
}

/** Validate one pricing row from `.zoo/pricing.json`. */
function coercePricing(value: unknown): ModelPricing | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.model !== 'string' || value.model.trim().length === 0) return undefined
  if (typeof value.promptUsdPerMillion !== 'number' || !Number.isFinite(value.promptUsdPerMillion)) {
    return undefined
  }
  if (
    typeof value.completionUsdPerMillion !== 'number' ||
    !Number.isFinite(value.completionUsdPerMillion)
  ) {
    return undefined
  }
  return {
    model: value.model,
    promptUsdPerMillion: value.promptUsdPerMillion,
    completionUsdPerMillion: value.completionUsdPerMillion,
  }
}

/** Merge overrides onto a base table by (case-insensitive) model name. */
function mergePricing(base: ModelPricing[], overrides: ModelPricing[]): ModelPricing[] {
  const merged = new Map<string, ModelPricing>()
  for (const row of base) merged.set(row.model.trim().toLowerCase(), { ...row })
  for (const row of overrides) merged.set(row.model.trim().toLowerCase(), { ...row })
  return [...merged.values()]
}

/**
 * Load the effective pricing table: {@link DEFAULT_PRICING} with any rows from
 * `<root>/.zoo/pricing.json` overriding them by model name.
 *
 * Never throws. A missing file simply yields the defaults; a corrupt file yields
 * `{ ok: false }` **and** the defaults as `data`, so a bad override can never
 * silently blank out pricing.
 */
export function loadPricing(root?: string): { ok: boolean; data: ModelPricing[]; error?: string } {
  const fallback = DEFAULT_PRICING.map((row) => ({ ...row }))
  try {
    const file = join(getUsageDir(root), PricingFileName)
    if (!existsSync(file)) return { ok: true, data: fallback }

    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch (err) {
      return { ok: false, data: fallback, error: `Failed to read pricing file: ${errorMessage(err)}` }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return {
        ok: false,
        data: fallback,
        error: `Corrupt pricing file ${file}: ${errorMessage(err)}`,
      }
    }

    const overrides: ModelPricing[] = []
    if (isRecord(parsed) && Array.isArray(parsed.models)) {
      for (const item of parsed.models) {
        const row = coercePricing(item)
        if (row !== undefined) overrides.push(row)
      }
    }
    return { ok: true, data: mergePricing(fallback, overrides) }
  } catch (err) {
    return { ok: false, data: fallback, error: `Failed to load pricing: ${errorMessage(err)}` }
  }
}

/* -------------------------------------------------------------------------- */
/* Summaries                                                                  */
/* -------------------------------------------------------------------------- */

function emptyTotals(): UsageTotals {
  return {
    runs: 0,
    steps: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    durationMs: 0,
  }
}

function addEntry(acc: UsageTotals, entry: UsageEntry, pricing: ModelPricing[]): void {
  acc.runs += 1
  acc.steps += entry.steps
  acc.promptTokens += entry.promptTokens
  acc.completionTokens += entry.completionTokens
  acc.totalTokens += entry.totalTokens
  acc.durationMs += entry.durationMs
  acc.estimatedCostUsd = roundUsd(
    acc.estimatedCostUsd +
      estimateCostUsd(entry.model, entry.promptTokens, entry.completionTokens, pricing),
  )
}

/**
 * Aggregate entries into overall / per-model / per-day totals.
 *
 * `options.days` restricts the window to the last N days relative to
 * `options.now` (injected for deterministic tests); omit it to summarize
 * everything. `options.pricing` overrides {@link DEFAULT_PRICING} — the CLI
 * passes the table loaded from `.zoo/pricing.json`.
 *
 * `skippedLines` is always `0` here (nothing was parsed); the caller that used
 * {@link readUsage} copies its own count onto the returned summary.
 */
export function summarizeUsage(
  entries: UsageEntry[],
  options?: { days?: number; now?: Date; pricing?: ModelPricing[] },
): UsageSummary {
  const pricing = options?.pricing ?? DEFAULT_PRICING
  const now = options?.now ?? new Date()
  const days = options?.days
  const cutoff =
    typeof days === 'number' && Number.isFinite(days)
      ? now.getTime() - days * 86_400_000
      : undefined

  const kept =
    cutoff === undefined
      ? entries
      : entries.filter((entry) => {
          const parsed = Date.parse(entry.ts)
          return Number.isFinite(parsed) ? parsed >= cutoff : false
        })

  const overall = emptyTotals()
  const byModel: Record<string, UsageTotals> = {}
  const byDayRaw: Record<string, UsageTotals> = {}
  const unpriced = new Set<string>()
  let firstTs: string | undefined
  let lastTs: string | undefined

  for (const entry of kept) {
    addEntry(overall, entry, pricing)

    const modelKey = entry.model
    if (byModel[modelKey] === undefined) byModel[modelKey] = emptyTotals()
    addEntry(byModel[modelKey], entry, pricing)

    const day = entry.ts.slice(0, 10)
    if (byDayRaw[day] === undefined) byDayRaw[day] = emptyTotals()
    addEntry(byDayRaw[day], entry, pricing)

    if (pricingFor(entry.model, pricing) === undefined) unpriced.add(entry.model)

    if (firstTs === undefined || entry.ts < firstTs) firstTs = entry.ts
    if (lastTs === undefined || entry.ts > lastTs) lastTs = entry.ts
  }

  const byDay: Record<string, UsageTotals> = {}
  for (const key of Object.keys(byDayRaw).sort()) byDay[key] = byDayRaw[key]

  const summary: UsageSummary = {
    overall,
    byModel,
    byDay,
    entries: kept.length,
    skippedLines: 0,
    unpricedModels: [...unpriced].sort(),
  }
  if (firstTs !== undefined) summary.firstTs = firstTs
  if (lastTs !== undefined) summary.lastTs = lastTs
  return summary
}

/* -------------------------------------------------------------------------- */
/* Run ids                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Short, collision-resistant run id with no dependencies: base36 millisecond
 * timestamp + 8 hex chars of a UUIDv4. Distinct enough for a local ledger while
 * staying readable in `zoocode usage` output.
 */
export function makeRunId(): string {
  return `${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
}
