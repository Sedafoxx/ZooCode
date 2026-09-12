/**
 * Minimal, dependency-free `.env` loader.
 *
 * Design intent: [`loadConfig()`](lib/config.ts:76) stays a PURE env reader so
 * its behaviour is deterministic and independent of anything on disk. Entry
 * points (`bin/zoocode.ts`, `scripts/live-test.ts`, `tests/live.test.ts`) opt in
 * by calling `loadDotenv()` explicitly before resolving configuration.
 *
 * Precedence: a real environment variable ALWAYS wins. A `.env` file can never
 * override an explicitly exported value, and an empty/whitespace-only variable
 * is treated as absent (matching `cleanString` in `lib/config.ts`).
 *
 * SECURITY: values are written into `process.env` only. Nothing in this module
 * ever prints, logs, or serializes a value.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LoadDotenvResult {
  /** False only when the file existed but could not be read/parsed. */
  ok: boolean
  /** Absolute path that was consulted. */
  path: string
  /** Whether the file existed. A missing `.env` is not an error. */
  found: boolean
  /** Number of variables written into the target env object. */
  loaded: number
  /** Number of variables skipped because a real env var already set them. */
  skipped: number
  /** True when loading was suppressed by an escape hatch (see `NO_DOTENV_KEY`). */
  disabled: boolean
  error?: string
}

export interface LoadDotenvOptions {
  /** Override the file location (defaults to `<repoRoot>/.env`). */
  path?: string
  /** Target object (defaults to `process.env`); injectable for tests. */
  env?: Record<string, string | undefined>
}

/** Keys must look like shell identifiers, so junk lines can never pollute env. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Repository root: this module lives in `<root>/lib/`. */
export function getRepoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** Default location of the local secrets file. */
export function getDefaultEnvPath(): string {
  return join(getRepoRoot(), '.env')
}

/** Expand the escape sequences supported inside double-quoted values. */
function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_match, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case '"':
        return '"'
      case '\\':
        return '\\'
      default:
        return ch
    }
  })
}

/**
 * Parse `.env` text into a plain object. Pure — no filesystem or env access.
 * Supports `KEY=value`, `export KEY=value`, blank lines, `#` comments,
 * single/double quoted values, and unquoted trailing ` # comment`.
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()

    const eq = line.indexOf('=')
    if (eq <= 0) continue

    const key = line.slice(0, eq).trim()
    if (!KEY_PATTERN.test(key)) continue

    let value = line.slice(eq + 1).trim()
    const quote = value[0]

    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
      if (quote === '"') value = unescapeDoubleQuoted(value)
    } else {
      const comment = value.indexOf(' #')
      if (comment >= 0) value = value.slice(0, comment).trim()
    }

    result[key] = value
  }

  return result
}

/**
 * Escape hatches so callers — above all tests — can stay hermetic.
 *
 *   ZOO_NO_DOTENV=1       skip `.env` entirely
 *   ZOO_ENV_FILE=<path>   read a different file instead of `<repoRoot>/.env`
 *
 * These exist because a repository may legitimately contain a `.env` with a
 * real key: without an opt-out, any test asserting "no key configured" would
 * silently pick the key up and start making billed network calls. An explicit
 * `options.path` always wins over `ZOO_NO_DOTENV`.
 */
export const NO_DOTENV_KEY = 'ZOO_NO_DOTENV'
export const ENV_FILE_KEY = 'ZOO_ENV_FILE'

function isTruthy(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  const flag = value.trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

function cleanPath(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Load `<repoRoot>/.env` (or `options.path`, or `$ZOO_ENV_FILE`) into
 * `process.env` (or `options.env`). Never throws and never overrides an
 * existing non-empty value.
 */
export function loadDotenv(options: LoadDotenvOptions = {}): LoadDotenvResult {
  const env = options.env ?? process.env

  if (options.path === undefined && isTruthy(env[NO_DOTENV_KEY])) {
    return { ok: true, path: '', found: false, loaded: 0, skipped: 0, disabled: true }
  }

  const path = options.path ?? cleanPath(env[ENV_FILE_KEY]) ?? getDefaultEnvPath()
  const result: LoadDotenvResult = {
    ok: true,
    path,
    found: false,
    loaded: 0,
    skipped: 0,
    disabled: false,
  }

  try {
    if (!existsSync(path)) return result

    const parsed = parseDotenv(readFileSync(path, 'utf-8'))
    result.found = true

    for (const [key, value] of Object.entries(parsed)) {
      const existing = env[key]
      if (typeof existing === 'string' && existing.trim().length > 0) {
        result.skipped += 1
        continue
      }
      env[key] = value
      result.loaded += 1
    }

    return result
  } catch (err) {
    return {
      ...result,
      ok: false,
      error: `Failed to load ${path}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
