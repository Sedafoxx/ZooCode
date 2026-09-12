/**
 * Persistent cross-session context memory ("state of the world").
 *
 * Stores a JSON document at `<root>/.zoo/state.json` describing the projects
 * Zoo has touched, with per-project notes and todos. This is the store an
 * agent reads at session start so it never loses context between sessions.
 *
 * Result shape follows the shared contract:
 *   { ok: true,  data: ... }
 *   { ok: false, error: string }
 *
 * Every public function accepts an optional `root` argument (or the
 * `ZOOCONTEXT_DIR` env var) to redirect state into a temp dir for
 * testability. When neither is given, state resolves relative to the repo
 * root via `import.meta.url` — never the hardcoded absolute user path.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ProjectRecord {
  name: string
  path: string
  lastAnalyzed?: string // ISO timestamp
  notes: string[]
  todos: string[]
}

export interface ZooState {
  version: 1
  updatedAt: string
  projects: Record<string, ProjectRecord>
}

export interface ContextSnapshot {
  state: ZooState
  summary: string // condensed human-readable "state of the world"
  projectCount: number
}

const StateFileName = 'state.json'

/** Repo root resolved from this module's own location (lib/ is one level down). */
const RepoRoot = fileURLToPath(new URL('../', import.meta.url))

/** Resolve the base directory for state storage: explicit root > env var > repo root. */
function resolveRoot(root?: string): string {
  if (root) return root
  const env = process.env.ZOOCONTEXT_DIR
  if (env) return env
  return RepoRoot
}

/**
 * The directory that holds the state file, `<resolvedRoot>/.zoo`.
 */
export function getStateDir(root?: string): string {
  return join(resolveRoot(root), '.zoo')
}

function emptyState(): ZooState {
  return { version: 1, updatedAt: new Date().toISOString(), projects: {} }
}

function isZooState(value: unknown): value is ZooState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.version === 1 && typeof v.projects === 'object' && v.projects !== null
}

/**
 * Load `.zoo/state.json`. Never throws: a missing file yields the default
 * empty state; corrupt JSON or an unreadable file yields `{ ok: false }`.
 */
export function loadState(root?: string): { ok: boolean; data?: ZooState; error?: string } {
  const file = join(getStateDir(root), StateFileName)
  if (!existsSync(file)) {
    return { ok: true, data: emptyState() }
  }

  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch (err) {
    return { ok: false, error: `Failed to read state file: ${(err as Error).message}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `Corrupt state file ${file}: ${(err as Error).message}` }
  }

  if (!isZooState(parsed)) {
    return { ok: true, data: emptyState() }
  }
  return { ok: true, data: parsed }
}

/**
 * Persist the whole state back to `.zoo/state.json`. Writes to a temp file
 * and renames for crash-safe atomic replacement. Never throws.
 */
export function saveState(state: ZooState, root?: string): { ok: boolean; data?: ZooState; error?: string } {
  try {
    const dir = getStateDir(root)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, StateFileName)
    const tmp = join(dir, `state.json.tmp-${process.pid}`)
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tmp, file)
    return { ok: true, data: state }
  } catch (err) {
    return { ok: false, error: `Failed to save state: ${(err as Error).message}` }
  }
}

/**
 * Load the whole state, apply a mutation to one project record, and persist
 * the whole state back (load-modify-save atomically).
 */
function upsertProject(
  name: string,
  mutate: (rec: ProjectRecord) => ProjectRecord,
  root?: string
): { ok: boolean; data?: ProjectRecord; error?: string } {
  const loaded = loadState(root)
  if (!loaded.ok || !loaded.data) {
    return { ok: false, error: loaded.error ?? 'Failed to load state' }
  }
  const state = loaded.data
  const existing = state.projects[name]
  const rec: ProjectRecord = existing ?? { name, path: name, notes: [], todos: [] }
  const next = mutate(rec)
  state.projects[name] = next
  state.updatedAt = new Date().toISOString()
  const saved = saveState(state, root)
  if (!saved.ok) {
    return { ok: false, error: saved.error }
  }
  return { ok: true, data: next }
}

/**
 * Append a note to a project, upserting the record if it does not exist yet.
 */
export function addProjectNote(
  name: string,
  note: string,
  root?: string
): { ok: boolean; data?: ProjectRecord; error?: string } {
  return upsertProject(
    name,
    (rec) => ({
      ...rec,
      lastAnalyzed: new Date().toISOString(),
      notes: [...(rec.notes ?? []), note],
    }),
    root
  )
}

/**
 * Append a todo to a project, upserting the record if it does not exist yet.
 */
export function addProjectTodo(
  name: string,
  todo: string,
  root?: string
): { ok: boolean; data?: ProjectRecord; error?: string } {
  return upsertProject(
    name,
    (rec) => ({
      ...rec,
      lastAnalyzed: new Date().toISOString(),
      todos: [...(rec.todos ?? []), todo],
    }),
    root
  )
}

/**
 * Build a snapshot + dense human-readable summary of the recorded projects.
 * If `projectNames` is omitted, every recorded project is summarized.
 */
export function collectContext(
  projectNames?: string[],
  root?: string
): { ok: boolean; data?: ContextSnapshot; error?: string } {
  const loaded = loadState(root)
  if (!loaded.ok || !loaded.data) {
    return { ok: false, error: loaded.error ?? 'Failed to load state' }
  }
  const state = loaded.data

  const requested = projectNames && projectNames.length > 0 ? projectNames : Object.keys(state.projects)
  const present = requested.filter((name) => state.projects[name])

  const lines: string[] = []
  lines.push(`Zoo state: ${present.length} project${present.length === 1 ? '' : 's'} — updated ${state.updatedAt}`)
  for (const name of present) {
    const rec = state.projects[name]
    const analyzed = rec.lastAnalyzed ?? 'never'
    lines.push(`- ${name}: notes=${(rec.notes ?? []).length} todos=${(rec.todos ?? []).length} analyzed=${analyzed}`)
  }

  return {
    ok: true,
    data: {
      state,
      summary: lines.join('\n'),
      projectCount: present.length,
    },
  }
}
