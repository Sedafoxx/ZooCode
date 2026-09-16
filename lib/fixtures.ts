/**
 * Record and replay `run_command` output, so iterating on a slow check costs
 * nothing.
 *
 * Why this exists: the expensive part of an agent run is not editing, it is
 * re-running. One observed phase spent four pipeline runs — each an LLM call plus
 * 16 paid searches plus 45 network validations — to test changes of a few lines,
 * because the pipeline was the only way to see whether the change worked. With
 * fixtures, that first expensive run is recorded once and every later iteration
 * reads it back in milliseconds, deterministically and for free.
 *
 * The safety property is the important half: **in replay mode a command with no
 * recording FAILS LOUDLY and never executes**. A replay that silently ran the real
 * command (or silently returned empty) would be worse than no replay at all,
 * because it would make an agent believe it had verified something. For the same
 * reason the policy gate is evaluated BEFORE a replay is served, so a refused
 * command stays refused and the agent learns the same lesson in both modes.
 *
 * This is deliberately keyed on the command text rather than on HTTP: the harness
 * has no business intercepting a program's own network calls, and a command whose
 * output is not reproducible is exactly the thing worth replaying.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type FixtureMode = 'off' | 'record' | 'replay'

export interface FixtureEntry {
  command: string
  ok: boolean
  exitCode: number
  content: string
  error?: string
  recordedAt: string
}

export interface FixtureStats {
  mode: FixtureMode
  /** Replays served from the store. */
  hits: number
  /** Replay attempts with no recording — each one is a hard failure for the tool. */
  misses: number
  recorded: number
  /** Total entries in the store, including ones this run never touched. */
  total: number
}

export interface FixtureStore {
  mode: FixtureMode
  file: string
  lookup(command: string): FixtureEntry | undefined
  record(entry: Omit<FixtureEntry, 'recordedAt'>): void
  stats(): FixtureStats
  flush(): boolean
}

/** Default location, inside the repo-local state directory that is already ignored. */
export const FIXTURE_FILE_REL = join('.zoo', 'fixtures.json')

/**
 * Commands match on normalised text — trimmed, with whitespace runs collapsed —
 * so `npm  run   test` replays the recording of `npm run test` rather than
 * producing a puzzling miss.
 */
export function fixtureKey(command: string): string {
  return String(command ?? '').replace(/\s+/g, ' ').trim()
}

interface FixtureFile {
  version: number
  entries: Record<string, FixtureEntry>
}

function load(file: string): Map<string, FixtureEntry> {
  const entries = new Map<string, FixtureEntry>()
  if (!existsSync(file)) return entries
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<FixtureFile>
    for (const [key, value] of Object.entries(parsed.entries ?? {})) {
      if (value && typeof value.content === 'string') entries.set(key, value as FixtureEntry)
    }
  } catch {
    // A corrupt store must not stop a run; it just starts empty and will be
    // rewritten on the next record.
  }
  return entries
}

function write(file: string, entries: Map<string, FixtureEntry>): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const payload: FixtureFile = {
      version: 1,
      entries: Object.fromEntries(entries),
    }
    // Temp file + rename: a crash mid-write cannot leave a half-parsed store.
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/**
 * Open the store at `file`. Never throws: an unreadable or corrupt store behaves
 * as empty, because losing recorded output should cost time, not the run.
 */
export function createFixtureStore(options: { mode: FixtureMode; file: string }): FixtureStore {
  const entries = load(options.file)
  let hits = 0
  let misses = 0
  let recorded = 0

  return {
    mode: options.mode,
    file: options.file,

    lookup(command: string): FixtureEntry | undefined {
      const found = entries.get(fixtureKey(command))
      if (options.mode === 'replay') {
        if (found === undefined) misses += 1
        else hits += 1
      }
      return found
    },

    record(entry: Omit<FixtureEntry, 'recordedAt'>): void {
      entries.set(fixtureKey(entry.command), { ...entry, recordedAt: new Date().toISOString() })
      recorded += 1
      // Written immediately rather than at the end: a run that dies at its step
      // cap should still leave behind the recordings it already paid for.
      write(options.file, entries)
    },

    stats(): FixtureStats {
      return { mode: options.mode, hits, misses, recorded, total: entries.size }
    },

    flush(): boolean {
      return write(options.file, entries)
    },
  }
}

/**
 * The line injected into the system prompt. In replay mode this is not optional
 * context — an agent that does not know the shell is simulated will misread a
 * replay miss as a broken environment and start "fixing" it.
 */
export function formatFixtureNotice(mode: FixtureMode, file: string): string {
  if (mode === 'off') return ''
  if (mode === 'record') {
    return [
      '## Command fixtures (RECORDING)',
      `- Every \`run_command\` result is being saved to ${file}.`,
      '- Prefer commands whose output you will want again: the slow check you are iterating on.',
    ].join('\n')
  }
  return [
    '## Command fixtures (REPLAYING — the shell is simulated)',
    `- \`run_command\` does NOT execute. It returns the output recorded in ${file}.`,
    '- A command with no recording returns `Replay miss` and a non-zero result. That is a missing ' +
      'recording, NOT a broken environment: do not try to repair it, and never invent the output.',
    '- Treat replayed output as what that command produced when it was recorded. If the repository has ' +
      'changed since, say so rather than assuming the recording is still current.',
  ].join('\n')
}
