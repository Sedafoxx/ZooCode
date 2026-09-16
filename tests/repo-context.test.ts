/**
 * Repo facts are injected into every run, so two things must hold: the probe never
 * throws on anything (it runs before any work happens), and the block is worth
 * reading — no empty sections printed as "none", no noise directories counted.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  formatRepoFacts,
  isProbableRepo,
  probeRepo,
  summariseRepoFacts,
  type RepoFacts,
} from '../lib/repo-context.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'zoo-repocontext-'))
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

/** A small but realistic repo of the kind this harness is pointed at. */
function makeRepo(): string {
  const dir = tempDir()
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'demo-app',
      scripts: { build: 'next build', test: 'vitest run', migrate: 'node scripts/migrate.mjs' },
    }),
    'utf-8',
  )
  for (const marker of ['tsconfig.json', 'next.config.ts', 'vitest.config.ts', 'tailwind.config.js']) {
    writeFileSync(join(dir, marker), '{}', 'utf-8')
  }
  mkdirSync(join(dir, 'supabase', 'migrations'), { recursive: true })
  writeFileSync(join(dir, 'supabase', 'migrations', '0001_init.sql'), 'select 1;', 'utf-8')
  writeFileSync(join(dir, 'supabase', 'migrations', '0002_more.sql'), 'select 2;', 'utf-8')
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'src', 'lib', 'thing.ts'), 'export const x = 1', 'utf-8')
  // Noise that must never be counted.
  mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'junk', 'index.js'), 'x'.repeat(100), 'utf-8')
  mkdirSync(join(dir, '.next'), { recursive: true })
  writeFileSync(join(dir, '.next', 'build.js'), 'y'.repeat(100), 'utf-8')
  // The durable half: conventions a probe cannot derive.
  mkdirSync(join(dir, '.zoo'), { recursive: true })
  writeFileSync(
    join(dir, '.zoo', 'context.md'),
    'Always use `edit_file`. Migrations are additive. Never push `finances/`.',
    'utf-8',
  )
  return dir
}

describe('probeRepo', () => {
  it('reads the package, the scripts and the detected stack', () => {
    const dir = makeRepo()
    try {
      const facts = probeRepo(dir)
      expect(facts.packageName).toBe('demo-app')
      expect(facts.packageManager).toBe('npm')
      expect(facts.scripts.map((s) => s.name)).toEqual(['build', 'test', 'migrate'])
      expect(facts.markers).toEqual(
        expect.arrayContaining(['TypeScript', 'Next.js', 'vitest', 'Tailwind', 'Supabase']),
      )
    } finally {
      cleanup(dir)
    }
  })

  it('finds the newest migration', () => {
    const dir = makeRepo()
    try {
      const facts = probeRepo(dir)
      expect(facts.migrationDir).toBe('supabase/migrations')
      expect(facts.migrationCount).toBe(2)
      expect(facts.newestMigration).toBe('0002_more.sql')
    } finally {
      cleanup(dir)
    }
  })

  it('skips noise directories when counting', () => {
    const dir = makeRepo()
    try {
      const facts = probeRepo(dir)
      const allExtensions = facts.extensions.map(([ext]) => ext)
      expect(allExtensions).not.toContain('(none)')
      // src is the only counted source directory; node_modules and .next are not.
      expect(facts.topDirs.map((d) => d.name)).toContain('src')
      expect(facts.topDirs.map((d) => d.name)).not.toContain('node_modules')
      expect(facts.topDirs.map((d) => d.name)).not.toContain('.next')
      // No package.json/tsconfig/migration counts are inflated by the noise files.
      expect(facts.files).toBeLessThan(20)
    } finally {
      cleanup(dir)
    }
  })

  it('carries the repo notes that no probe could derive', () => {
    const dir = makeRepo()
    try {
      expect(probeRepo(dir).notes).toContain('Always use `edit_file`')
    } finally {
      cleanup(dir)
    }
  })

  it('truncates enormous notes instead of flooding the prompt', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, '.zoo', 'context.md'), 'n'.repeat(5_000), 'utf-8')
      const notes = probeRepo(dir).notes ?? ''
      expect(notes).toContain('[truncated]')
      expect(notes.length).toBeLessThan(1_700)
    } finally {
      cleanup(dir)
    }
  })

  it('returns empty commits (not an error) outside a git repository', () => {
    const dir = makeRepo()
    try {
      expect(probeRepo(dir).recentCommits).toEqual([])
    } finally {
      cleanup(dir)
    }
  })

  it('never throws on a root that does not exist', () => {
    const facts = probeRepo(join(tmpdir(), 'zoo-definitely-missing-root'))
    expect(facts.files).toBe(0)
    expect(facts.packageName).toBeNull()
    expect(facts.migrationDir).toBeNull()
    expect(facts.notes).toBeNull()
  })
})

describe('formatRepoFacts', () => {
  const FULL: RepoFacts = {
    root: 'C:\\proj',
    packageName: 'demo-app',
    packageManager: 'npm',
    scripts: [{ name: 'build', command: 'next build' }],
    markers: ['TypeScript', 'Next.js'],
    files: 42,
    extensions: [['ts', 30], ['sql', 2]],
    topDirs: [{ name: 'src', files: 30 }],
    migrationDir: 'supabase/migrations',
    migrationCount: 21,
    newestMigration: '0021_miss_count.sql',
    recentCommits: ['abc123 feat: a thing'],
    notes: 'House rule: prefer edit_file.',
  }

  it('states the facts the agent would otherwise re-read files to learn', () => {
    const block = formatRepoFacts(FULL)
    expect(block).toContain('Repository facts')
    expect(block).toContain('demo-app')
    expect(block).toContain('npm scripts: build')
    expect(block).toContain('42 files')
    expect(block).toContain('Migrations: supabase/migrations — 21 file(s), newest 0021_miss_count.sql')
    expect(block).toContain('Recent commits: abc123 feat: a thing')
    expect(block).toContain('prefer edit_file')
  })

  it('omits sections it has nothing to say about rather than printing "none"', () => {
    const bare: RepoFacts = {
      root: '/empty',
      packageName: null,
      packageManager: null,
      scripts: [],
      markers: [],
      files: 0,
      extensions: [],
      topDirs: [],
      migrationDir: null,
      migrationCount: 0,
      newestMigration: null,
      recentCommits: [],
      notes: null,
    }
    const block = formatRepoFacts(bare)
    expect(block).not.toContain('Recent commits')
    expect(block).not.toContain('Migrations:')
    expect(block).not.toContain('npm scripts')
    expect(block).toContain('no package.json')
  })
})

describe('summariseRepoFacts', () => {
  it('is one line for logs and the JSON payload', () => {
    const facts = probeRepo(makeRepo())
    expect(summariseRepoFacts(facts)).toContain('demo-app')
    expect(summariseRepoFacts(facts)).toContain('script(s)')
  })
})

describe('isProbableRepo', () => {
  it('is true for a real directory and false for a missing one', () => {
    const dir = makeRepo()
    try {
      expect(isProbableRepo(dir)).toBe(true)
    } finally {
      cleanup(dir)
    }
    expect(isProbableRepo(join(tmpdir(), 'zoo-definitely-missing-root'))).toBe(false)
  })
})
