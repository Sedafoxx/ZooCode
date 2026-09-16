/**
 * What is already knowable about a repository, probed once per run and injected
 * into the agent's system prompt.
 *
 * Why this exists: every observed run opened by re-reading `package.json`, calling
 * `list_files`, and reading a migration to learn things the harness can compute
 * itself. Across four runs that was roughly eight steps per run spent rediscovering
 * the same facts — and the facts never change between runs, unlike the code.
 *
 * The split is deliberate:
 *  - `probeRepo()` touches the filesystem and git, is bounded, and never throws
 *  - `formatRepoFacts()` is pure, so the wording is unit-testable without a repo
 *
 * There is also a durable half: if the repository keeps `<root>/.zoo/context.md`,
 * its contents are injected verbatim. That is where facts that are NOT derivable
 * belong — house conventions, a gotcha, which verify command actually works — and
 * unlike the probed half it is written once and then reused by every later run.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Directories that are never worth walking, or counting. */
const NOISE_DIRS = new Set([
  'node_modules',
  '.git',
  '.zoo',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  '.cache',
  '.turbo',
])

/** Stops a pathological tree from turning a probe into a stall. */
const MAX_FILES_WALKED = 5_000
const MAX_NOTES_CHARS = 1_500

export interface RepoScript {
  name: string
  command: string
}

export interface RepoFacts {
  root: string
  packageName: string | null
  packageManager: string | null
  scripts: RepoScript[]
  /** Human-readable stack markers, e.g. "TypeScript", "Next.js", "vitest". */
  markers: string[]
  files: number
  extensions: [string, number][]
  topDirs: { name: string; files: number }[]
  migrationDir: string | null
  migrationCount: number
  newestMigration: string | null
  recentCommits: string[]
  /** Contents of `<root>/.zoo/context.md`, when the repo keeps one. */
  notes: string | null
}

function safeRead(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Bounded recursive walk returning relative file paths, noise directories skipped. */
function walkFiles(root: string, max = MAX_FILES_WALKED): string[] {
  const out: string[] = []
  const queue: { dir: string; rel: string }[] = [{ dir: root, rel: '' }]

  while (queue.length > 0) {
    const current = queue.shift() as { dir: string; rel: string }
    for (const entry of safeReaddir(current.dir)) {
      if (out.length >= max) return out
      if (NOISE_DIRS.has(entry)) continue
      const full = join(current.dir, entry)
      const rel = current.rel === '' ? entry : `${current.rel}/${entry}`
      try {
        const stats = statSync(full)
        if (stats.isDirectory()) queue.push({ dir: full, rel })
        else if (stats.isFile()) out.push(rel)
      } catch {
        // Unreadable entry: skip it rather than abort the probe.
      }
    }
  }
  return out
}

function readPackage(root: string): { name: string | null; scripts: RepoScript[] } {
  const raw = safeRead(join(root, 'package.json'))
  if (raw === null) return { name: null, scripts: [] }
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; scripts?: Record<string, unknown> }
    const name = typeof parsed.name === 'string' ? parsed.name : null
    const scripts = Object.entries(parsed.scripts ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([scriptName, command]) => ({ name: scriptName, command }))
    return { name, scripts }
  } catch {
    return { name: null, scripts: [] }
  }
}

function detectPackageManager(root: string): string | null {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb'))) return 'bun'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'
  return existsSync(join(root, 'package.json')) ? 'npm' : null
}

/** Markers are pure file presence — no parsing, no guessing from contents. */
function detectMarkers(root: string): string[] {
  const markers: string[] = []
  const has = (rel: string): boolean => existsSync(join(root, rel))
  if (has('tsconfig.json')) markers.push('TypeScript')
  if (has('next.config.ts') || has('next.config.js') || has('next.config.mjs')) markers.push('Next.js')
  if (has('vitest.config.ts') || has('vitest.config.js')) markers.push('vitest')
  if (has('jest.config.js') || has('jest.config.ts')) markers.push('jest')
  if (has('tailwind.config.ts') || has('tailwind.config.js')) markers.push('Tailwind')
  if (has('supabase')) markers.push('Supabase')
  if (has('pyproject.toml') || has('requirements.txt')) markers.push('Python')
  if (has('go.mod')) markers.push('Go')
  if (has('Cargo.toml')) markers.push('Rust')
  return markers
}

/** Candidate migration directories, nearest first, bounded in depth. */
function findMigrationDir(root: string): string | null {
  const candidates = [
    'supabase/migrations',
    'migrations',
    'db/migrations',
    'prisma/migrations',
    'alembic/versions',
  ]
  for (const rel of candidates) {
    if (isDir(join(root, rel))) return rel
  }
  return null
}

function recentCommits(root: string, count = 5): string[] {
  try {
    const run = spawnSync('git', ['log', `-${count}`, '--oneline'], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 5_000,
    })
    if (run.error || run.status !== 0) return []
    return String(run.stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}

/**
 * Facts about the repository at `root`. Never throws: a missing root, an
 * unreadable file or a non-git directory each degrade to an absent fact.
 */
export function probeRepo(root: string): RepoFacts {
  const files = walkFiles(root)
  const pkg = readPackage(root)
  const migrationDir = findMigrationDir(root)

  const extensionCounts = new Map<string, number>()
  const dirCounts = new Map<string, number>()
  for (const rel of files) {
    const dot = rel.lastIndexOf('.')
    const ext = dot === -1 ? '(none)' : rel.slice(dot + 1).toLowerCase()
    extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1)

    const slash = rel.indexOf('/')
    const top = slash === -1 ? '(root files)' : rel.slice(0, slash)
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1)
  }

  let migrationCount = 0
  let newestMigration: string | null = null
  if (migrationDir !== null) {
    const entries = safeReaddir(join(root, migrationDir))
      .filter((entry) => entry.toLowerCase().endsWith('.sql'))
      .sort()
    migrationCount = entries.length
    newestMigration = entries.length > 0 ? entries[entries.length - 1] : null
  }

  const notesRaw = safeRead(join(root, '.zoo', 'context.md'))
  const notes =
    notesRaw === null
      ? null
      : notesRaw.length > MAX_NOTES_CHARS
        ? `${notesRaw.slice(0, MAX_NOTES_CHARS)}\n[truncated]`
        : notesRaw

  return {
    root,
    packageName: pkg.name,
    packageManager: detectPackageManager(root),
    scripts: pkg.scripts,
    markers: detectMarkers(root),
    files: files.length,
    extensions: [...extensionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    topDirs: [...dirCounts.entries()]
      .filter(([name]) => name !== '(root files)')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => ({ name, files: count })),
    migrationDir,
    migrationCount,
    newestMigration,
    recentCommits: recentCommits(root),
    notes,
  }
}

/**
 * The injected block. Every line is a fact the agent would otherwise spend steps
 * rediscovering, and the heading says not to re-read the underlying files for it.
 * Empty sections are omitted rather than printed as "none", so the block stays
 * worth reading.
 */
export function formatRepoFacts(facts: RepoFacts): string {
  const lines: string[] = [
    '## Repository facts (probed at run start — you do not need to re-read these files to learn this)',
  ]

  const stack: string[] = []
  if (facts.packageName !== null) {
    stack.push(`Node project \`${facts.packageName}\``)
  }
  if (facts.packageManager !== null) stack.push(facts.packageManager)
  if (facts.markers.length > 0) stack.push(facts.markers.join(', '))
  if (stack.length > 0) lines.push(`- Stack: ${stack.join('; ')}`)
  else lines.push(`- Stack: no package.json; treat the tree as unclassified`)

  if (facts.scripts.length > 0) {
    const names = facts.scripts.map((s) => s.name)
    lines.push(`- npm scripts: ${names.join(', ')}`)
    lines.push(
      '- Run a project check through its own scripts where one exists (e.g. `npm run <name>`) ' +
        'rather than guessing a tool invocation.',
    )
  }

  lines.push(`- Size: ${facts.files} files (noise directories skipped)`)
  if (facts.extensions.length > 0) {
    lines.push(`- By extension: ${facts.extensions.map(([ext, n]) => `${ext} ${n}`).join(', ')}`)
  }
  if (facts.topDirs.length > 0) {
    lines.push(`- Largest directories: ${facts.topDirs.map((d) => `${d.name} ${d.files}`).join(', ')}`)
  }
  if (facts.migrationDir !== null) {
    lines.push(
      `- Migrations: ${facts.migrationDir} — ${facts.migrationCount} file(s)` +
        (facts.newestMigration ? `, newest ${facts.newestMigration}` : ''),
    )
    lines.push(
      '- Migrations are usually additive and already-applied ones are skipped; add a NEW numbered ' +
        'file rather than editing an applied one.',
    )
  }
  if (facts.recentCommits.length > 0) {
    lines.push(`- Recent commits: ${facts.recentCommits.join(' | ')}`)
  }
  if (facts.notes !== null && facts.notes.trim().length > 0) {
    lines.push(
      '- Repository notes (`.zoo/context.md`, maintained deliberately — trust these over your ' +
        'assumptions):',
      facts.notes.trim(),
    )
  }

  return lines.join('\n')
}

/** One-line summary for logs and the JSON payload. */
export function summariseRepoFacts(facts: RepoFacts): string {
  const stack = [facts.packageName ?? 'no package.json', ...facts.markers].filter(
    (part) => part.length > 0,
  )
  return `repo ${facts.files} files; ${stack.join('/')}; ${facts.scripts.length} script(s)`
}

/** True when the root looks like something worth probing at all. */
export function isProbableRepo(root: string): boolean {
  return isDir(root) && safeReaddir(root).length > 0
}
