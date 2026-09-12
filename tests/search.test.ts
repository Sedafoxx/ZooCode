import { describe, it, expect } from 'vitest'
import { searchProjects } from '../lib/search.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { tmpdir } from 'node:os'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'zoocode-search-'))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Write a file at a '/' separated relative path inside a project dir. */
function write(project: string, relPath: string, content: string): void {
  const full = join(project, ...relPath.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf-8')
}

/** Normalize a path to forward slashes for platform-agnostic assertions. */
function norm(p: string): string {
  return p.split('\\').join('/')
}

describe('searchProjects', () => {
  it('matches a pattern across a temp project tree', () => {
    const dir = tempDir()
    write(dir, 'src/a.ts', 'export function alpha() {}\nconst keep = 1\n')
    write(dir, 'b.ts', 'export function beta() {}\n')
    write(dir, 'notes.md', 'nothing relevant here\n')

    const res = searchProjects('function', { project: dir })
    expect(res.ok).toBe(true)
    const hits = res.data!.hits
    expect(hits.length).toBe(2)
    expect(hits.map((h) => h.project)).toEqual([basename(dir), basename(dir)])
    expect(hits.map((h) => norm(h.file)).sort()).toEqual(['b.ts', 'src/a.ts'])
    expect(hits.map((h) => h.line)).toEqual([1, 1])
    expect(hits.every((h) => h.text.includes('function'))).toBe(true)
    expect(typeof res.data!.durationMs).toBe('number')
    cleanup(dir)
  })

  it('respects the ext filter', () => {
    const dir = tempDir()
    write(dir, 'a.ts', 'needle here\n')
    write(dir, 'b.js', 'needle here\n')
    write(dir, 'c.md', 'needle here\n')

    const res = searchProjects('needle', { project: dir, ext: '.ts' })
    expect(res.ok).toBe(true)
    const hits = res.data!.hits
    expect(hits.length).toBe(1)
    expect(norm(hits[0].file)).toBe('a.ts')
    cleanup(dir)
  })

  it('accepts an ext filter without a leading dot', () => {
    const dir = tempDir()
    write(dir, 'a.ts', 'needle here\n')
    write(dir, 'b.js', 'needle here\n')

    const res = searchProjects('needle', { project: dir, ext: 'ts' })
    expect(res.ok).toBe(true)
    expect(res.data!.hits.length).toBe(1)
    expect(norm(res.data!.hits[0].file)).toBe('a.ts')
    cleanup(dir)
  })

  it('respects max per project', () => {
    const dir = tempDir()
    write(dir, 'a.ts', 'hit\nhit\nhit\nhit\nhit\n')

    const res = searchProjects('hit', { project: dir, ext: '.ts', max: 3 })
    expect(res.ok).toBe(true)
    expect(res.data!.hits.length).toBe(3)
    cleanup(dir)
  })

  it('skips node_modules, .git and other skip dirs', () => {
    const dir = tempDir()
    write(dir, 'src/a.ts', 'secret marker\n')
    write(dir, 'node_modules/dep/index.ts', 'secret marker\n')
    write(dir, '.git/config', 'secret marker\n')
    write(dir, '.claude/settings.json', 'secret marker\n')

    const res = searchProjects('secret marker', { project: dir })
    expect(res.ok).toBe(true)
    const hits = res.data!.hits
    expect(hits.length).toBe(1)
    expect(norm(hits[0].file)).toBe('src/a.ts')
    cleanup(dir)
  })

  it('restricts to the given project directory', () => {
    const dir = tempDir()
    write(dir, 'only.ts', 'needle\n')

    const res = searchProjects('needle', { project: dir })
    expect(res.ok).toBe(true)
    expect(res.data!.hits.length).toBe(1)
    expect(res.data!.hits[0].project).toBe(basename(dir))
    expect(norm(res.data!.hits[0].file)).toBe('only.ts')
    cleanup(dir)
  })

  it('returns { ok:false, error } when the target directory does not exist', () => {
    const missing = join(tmpdir(), `zoocode-missing-${Date.now()}`)
    const res = searchProjects('anything', { project: missing })
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    expect(res.data).toBeUndefined()
  })

  it('returns { ok:false, error } for an invalid regex pattern', () => {
    const dir = tempDir()
    const res = searchProjects('([unclosed', { project: dir })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Invalid pattern')
    cleanup(dir)
  })

  it('accepts a RegExp object pattern', () => {
    const dir = tempDir()
    write(dir, 'a.ts', 'alpha word\n')
    write(dir, 'b.ts', 'beta word\n')

    const res = searchProjects(/beta/, { project: dir, ext: '.ts' })
    expect(res.ok).toBe(true)
    expect(res.data!.hits.length).toBe(1)
    expect(norm(res.data!.hits[0].file)).toBe('b.ts')
    cleanup(dir)
  })
})
