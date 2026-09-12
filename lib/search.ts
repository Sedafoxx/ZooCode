/**
 * Native cross-project search.
 *
 * Walks project directories under the VSCode root (or a single project via the
 * `project` option), reads files as UTF-8, and reports lines matching a regex.
 * Pure node:fs / node:path — no child processes.
 *
 * Result shape follows the shared contract:
 *   { ok: true,  data: { hits: SearchHit[], durationMs } }
 *   { ok: false, error: string }
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, basename, relative, isAbsolute } from 'node:path'

export interface SearchHit {
  project: string
  file: string
  line: number
  text: string
}

export interface SearchOptions {
  ext?: string
  max?: number
  project?: string
  json?: boolean
}

const VSCodeDir = 'C:/Users/dchy/Documents/VSCode'

const SkipDirs = new Set([
  'node_modules',
  '.git',
  '.claude',
  '.playwright-mcp',
  'graphify-out',
  'dist',
  '__pycache__',
  '.vite',
  '.zoo',
])

const MaxDepth = 24
const DefaultMax = 20

function normalizeExt(ext: string): string {
  return ext.startsWith('.') ? ext : `.${ext}`
}

/**
 * Split file content into lines, tolerating CRLF and dropping a single trailing
 * empty line produced by a final newline.
 */
function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n')
  return normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n')
    : normalized.split('\n')
}

function collectHits(
  rootPath: string,
  dir: string,
  projectName: string,
  pattern: RegExp,
  opts: { ext?: string; max: number },
  counts: Map<string, number>,
  hits: SearchHit[],
  depth: number
): void {
  if (depth > MaxDepth) return

  let entries: Dirent[] | null = null
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // unreadable directory — skip
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isSymbolicLink()) continue // avoid symlink loops
    if (entry.isDirectory()) {
      if (SkipDirs.has(entry.name)) continue
      if (depth + 1 > MaxDepth) continue
      collectHits(rootPath, fullPath, projectName, pattern, opts, counts, hits, depth + 1)
      continue
    }
    if (!entry.isFile()) continue

    if (opts.ext && !entry.name.endsWith(opts.ext)) continue
    if ((counts.get(projectName) ?? 0) >= opts.max) return

    let content: string
    try {
      content = readFileSync(fullPath, 'utf-8')
    } catch {
      continue // binary or unreadable file — skip
    }

    const lines = splitLines(content)
    for (let i = 0; i < lines.length; i++) {
      if ((counts.get(projectName) ?? 0) >= opts.max) return
      if (!pattern.test(lines[i])) continue
      counts.set(projectName, (counts.get(projectName) ?? 0) + 1)
      hits.push({
        project: projectName,
        file: relative(rootPath, fullPath),
        line: i + 1,
        text: lines[i].trim(),
      })
    }
  }
}

export function searchProjects(
  pattern: RegExp | string,
  options?: SearchOptions
): { ok: boolean; data?: { hits: SearchHit[]; durationMs: number }; error?: string } {
  const start = Date.now()

  let regex: RegExp
  try {
    regex =
      typeof pattern === 'string'
        ? new RegExp(pattern)
        : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
  } catch (err) {
    return { ok: false, error: `Invalid pattern: ${(err as Error).message}` }
  }

  const ext = options?.ext ? normalizeExt(options.ext) : undefined
  const max = typeof options?.max === 'number' ? options.max : DefaultMax
  const project = options?.project

  let roots: { path: string; name: string }[]
  if (project) {
    // Accept an absolute path (used by tests/tooling) or a project name under the root.
    const projectPath = isAbsolute(project) ? project : join(VSCodeDir, project)
    let stat
    try {
      stat = statSync(projectPath)
    } catch {
      return { ok: false, error: `Project directory does not exist: ${projectPath}` }
    }
    if (!stat.isDirectory()) {
      return { ok: false, error: `Not a directory: ${projectPath}` }
    }
    roots = [{ path: projectPath, name: basename(projectPath) }]
  } else {
    if (!existsSync(VSCodeDir)) {
      return { ok: false, error: `Search root does not exist: ${VSCodeDir}` }
    }
    roots = readdirSync(VSCodeDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ path: join(VSCodeDir, e.name), name: e.name }))
  }

  const hits: SearchHit[] = []
  const counts = new Map<string, number>()

  for (const root of roots) {
    collectHits(root.path, root.path, root.name, regex, { ext, max }, counts, hits, 0)
  }

  return { ok: true, data: { hits, durationMs: Date.now() - start } }
}
