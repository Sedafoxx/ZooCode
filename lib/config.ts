/**
 * Configuration resolution for the agent harness.
 *
 * Precedence (lowest -> highest): built-in defaults, `process.env`, `overrides`.
 * `loadConfig` never throws; it returns a discriminated result object instead.
 */

export interface ZooConfig {
  apiKey: string
  baseUrl: string      // default 'https://api.deepseek.com'
  model: string        // default 'deepseek-chat'
  maxSteps: number     // default 25
  concurrency: number  // default 3
  temperature: number  // default 0.2
}

export interface ConfigResult {
  ok: boolean
  data?: ZooConfig
  error?: string
}

export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_MODEL = 'deepseek-chat'
export const DEFAULT_MAX_STEPS = 25
export const DEFAULT_CONCURRENCY = 3
export const DEFAULT_TEMPERATURE = 0.2

/** Environment variable names consumed by `loadConfig`. */
export const ENV_KEYS = {
  apiKey: 'DEEPSEEK_API_KEY',
  baseUrl: 'DEEPSEEK_BASE_URL',
  model: 'DEEPSEEK_MODEL',
  maxSteps: 'ZOO_MAX_STEPS',
  concurrency: 'ZOO_CONCURRENCY',
  temperature: 'ZOO_TEMPERATURE',
} as const

/** Trim a string-ish value; empty/whitespace-only values are treated as absent. */
function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Parse a finite number from a number or numeric string; anything else is absent. */
function cleanNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Step/concurrency counters must be whole numbers >= 1. */
function cleanCounter(value: unknown): number | undefined {
  const parsed = cleanNumber(value)
  if (parsed === undefined || parsed < 1) return undefined
  return Math.floor(parsed)
}

/** Temperature must be >= 0. */
function cleanTemperature(value: unknown): number | undefined {
  const parsed = cleanNumber(value)
  if (parsed === undefined || parsed < 0) return undefined
  return parsed
}

/**
 * Resolve configuration from `process.env` with optional overrides applied last.
 * Returns `{ ok: false, error }` when no API key is resolvable. Never throws.
 */
export function loadConfig(overrides?: Partial<ZooConfig>): ConfigResult {
  try {
    const env: NodeJS.ProcessEnv = process.env
    const override = overrides ?? {}

    const apiKey = cleanString(override.apiKey) ?? cleanString(env[ENV_KEYS.apiKey])
    if (!apiKey) {
      return {
        ok: false,
        error:
          `Missing API key: set ${ENV_KEYS.apiKey} in the environment ` +
          'or pass apiKey in overrides.',
      }
    }

    const data: ZooConfig = {
      apiKey,
      baseUrl:
        cleanString(override.baseUrl) ??
        cleanString(env[ENV_KEYS.baseUrl]) ??
        DEFAULT_BASE_URL,
      model:
        cleanString(override.model) ??
        cleanString(env[ENV_KEYS.model]) ??
        DEFAULT_MODEL,
      maxSteps:
        cleanCounter(override.maxSteps) ??
        cleanCounter(env[ENV_KEYS.maxSteps]) ??
        DEFAULT_MAX_STEPS,
      concurrency:
        cleanCounter(override.concurrency) ??
        cleanCounter(env[ENV_KEYS.concurrency]) ??
        DEFAULT_CONCURRENCY,
      temperature:
        cleanTemperature(override.temperature) ??
        cleanTemperature(env[ENV_KEYS.temperature]) ??
        DEFAULT_TEMPERATURE,
    }

    return { ok: true, data }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
