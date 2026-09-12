import { describe, it, expect } from 'vitest'
import {
  addProjectNote,
  addProjectTodo,
  collectContext,
  getStateDir,
  loadState,
  saveState,
} from '../lib/context.js'
import type { ZooState } from '../lib/context.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'zoocode-context-'))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Normalize a path to forward slashes for platform-agnostic assertions. */
function norm(p: string): string {
  return p.split('\\').join('/')
}

describe('loadState', () => {
  it('returns a default empty state when no state file exists', () => {
    const dir = tempDir()
    const res = loadState(dir)
    expect(res.ok).toBe(true)
    expect(res.data!.version).toBe(1)
    expect(res.data!.projects).toEqual({})
    expect(typeof res.data!.updatedAt).toBe('string')
    cleanup(dir)
  })

  it('returns { ok:false, error } for corrupt JSON, without throwing', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.zoo'), { recursive: true })
    writeFileSync(join(dir, '.zoo', 'state.json'), '{ not valid json', 'utf-8')
    const res = loadState(dir)
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    expect(res.data).toBeUndefined()
    cleanup(dir)
  })

  it('treats valid-but-misshaped JSON as an empty state', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.zoo'), { recursive: true })
    writeFileSync(join(dir, '.zoo', 'state.json'), JSON.stringify({ foo: 1 }), 'utf-8')
    const res = loadState(dir)
    expect(res.ok).toBe(true)
    expect(res.data!.projects).toEqual({})
    cleanup(dir)
  })
})

describe('saveState / loadState round-trip', () => {
  it('persists state to .zoo/state.json and loads it back', () => {
    const dir = tempDir()
    const state: ZooState = {
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      projects: {
        alpha: { name: 'alpha', path: 'alpha', notes: ['n1'], todos: ['t1'] },
      },
    }
    const saved = saveState(state, dir)
    expect(saved.ok).toBe(true)
    expect(existsSync(join(dir, '.zoo', 'state.json'))).toBe(true)

    const loaded = loadState(dir)
    expect(loaded.ok).toBe(true)
    expect(loaded.data).toEqual(state)
    cleanup(dir)
  })
})

describe('addProjectNote', () => {
  it('upserts a project record, appending notes', () => {
    const dir = tempDir()
    const first = addProjectNote('alpha', 'first note', dir)
    expect(first.ok).toBe(true)
    expect(first.data!.name).toBe('alpha')
    expect(first.data!.notes).toEqual(['first note'])
    expect(first.data!.todos).toEqual([])

    const second = addProjectNote('alpha', 'second note', dir)
    expect(second.ok).toBe(true)
    expect(second.data!.notes).toEqual(['first note', 'second note'])

    // Persisted across separate loads — not just in-memory.
    const loaded = loadState(dir)
    expect(loaded.data!.projects['alpha'].notes).toEqual(['first note', 'second note'])
    cleanup(dir)
  })
})

describe('addProjectTodo', () => {
  it('appends todos to a project record', () => {
    const dir = tempDir()
    const first = addProjectTodo('beta', 'do the thing', dir)
    expect(first.ok).toBe(true)
    expect(first.data!.todos).toEqual(['do the thing'])
    expect(first.data!.notes).toEqual([])

    const second = addProjectTodo('beta', 'do another thing', dir)
    expect(second.data!.todos).toEqual(['do the thing', 'do another thing'])
    cleanup(dir)
  })
})

describe('collectContext', () => {
  it('summary contains project names and note/todo counts', () => {
    const dir = tempDir()
    addProjectNote('alpha', 'note one', dir)
    addProjectNote('alpha', 'note two', dir)
    addProjectTodo('alpha', 'todo one', dir)
    addProjectTodo('beta', 'todo b1', dir)
    addProjectTodo('beta', 'todo b2', dir)

    const res = collectContext(undefined, dir)
    expect(res.ok).toBe(true)
    expect(res.data!.projectCount).toBe(2)

    const summary = res.data!.summary
    expect(summary).toContain('alpha')
    expect(summary).toContain('beta')
    expect(summary).toContain('notes=2')
    expect(summary).toContain('notes=0')
    expect(summary).toContain('todos=1')
    expect(summary).toContain('todos=2')
    cleanup(dir)
  })

  it('filters to the requested project names', () => {
    const dir = tempDir()
    addProjectNote('alpha', 'a', dir)
    addProjectNote('beta', 'b', dir)

    const res = collectContext(['alpha'], dir)
    expect(res.ok).toBe(true)
    expect(res.data!.projectCount).toBe(1)
    expect(res.data!.summary).toContain('alpha')
    expect(res.data!.summary).not.toContain('beta')
    cleanup(dir)
  })
})

describe('getStateDir', () => {
  it('resolves <root>/.zoo for an explicit root', () => {
    const dir = tempDir()
    expect(norm(getStateDir(dir))).toBe(`${norm(dir)}/.zoo`)
    cleanup(dir)
  })

  it('honors the ZOOCONTEXT_DIR env var', () => {
    const dir = tempDir()
    const prev = process.env.ZOOCONTEXT_DIR
    process.env.ZOOCONTEXT_DIR = dir
    try {
      expect(norm(getStateDir())).toBe(`${norm(dir)}/.zoo`)
    } finally {
      if (prev === undefined) {
        delete process.env.ZOOCONTEXT_DIR
      } else {
        process.env.ZOOCONTEXT_DIR = prev
      }
    }
    cleanup(dir)
  })
})
