import { describe, it, expect } from 'vitest'
import { parseStatus, getStatus, stageAll, commit, shortLog, init } from '../lib/git.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'

/** Create a fresh, initialized git repo with a local identity. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zoocode-git-test-'))
  init(dir)
  execSync('git config user.name "Zoo Test"', { cwd: dir })
  execSync('git config user.email "zoo@example.com"', { cwd: dir })
  return dir
}

/** Create a plain temp dir (not a git repo). */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'zoocode-git-test-'))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

describe('parseStatus', () => {
  it('parses an empty string to an empty array', () => {
    expect(parseStatus('')).toEqual([])
    expect(parseStatus('\n')).toEqual([])
  })

  it('parses staged changes (M, A, D)', () => {
    const files = parseStatus('M  src/index.ts\nA  src/new.ts\nD  src/old.ts\n')
    expect(files).toEqual([
      { path: 'src/index.ts', status: 'M', staged: true, untracked: false },
      { path: 'src/new.ts', status: 'A', staged: true, untracked: false },
      { path: 'src/old.ts', status: 'D', staged: true, untracked: false },
    ])
  })

  it('parses unstaged changes', () => {
    const files = parseStatus(' M src/index.ts\n D src/old.ts\n')
    expect(files).toEqual([
      { path: 'src/index.ts', status: 'M', staged: false, untracked: false },
      { path: 'src/old.ts', status: 'D', staged: false, untracked: false },
    ])
  })

  it('parses untracked files', () => {
    const files = parseStatus('?? untracked.txt\n?? dir/file.md\n')
    expect(files).toEqual([
      { path: 'untracked.txt', status: '??', staged: false, untracked: true },
      { path: 'dir/file.md', status: '??', staged: false, untracked: true },
    ])
  })

  it('parses MM (staged + unstaged) and treats R/C as staged', () => {
    const files = parseStatus('MM both.txt\nR  renamed.txt\nC  copied.txt\n')
    expect(files).toEqual([
      { path: 'both.txt', status: 'MM', staged: true, untracked: false },
      { path: 'renamed.txt', status: 'R', staged: true, untracked: false },
      { path: 'copied.txt', status: 'C', staged: true, untracked: false },
    ])
  })

  it('handles CRLF line endings', () => {
    const files = parseStatus('M  a.txt\r\n?? b.txt\r\n')
    expect(files).toHaveLength(2)
    expect(files[0].path).toBe('a.txt')
    expect(files[0].staged).toBe(true)
    expect(files[1].path).toBe('b.txt')
    expect(files[1].untracked).toBe(true)
  })
})

describe('getStatus', () => {
  it('returns staged and untracked files from a real repo', () => {
    const dir = tempRepo()
    try {
      writeFileSync(join(dir, 'tracked.txt'), 'hello')
      const staged = stageAll(dir)
      expect(staged.ok).toBe(true)
      expect(staged.data?.staged).toBe(1)

      writeFileSync(join(dir, 'untracked.txt'), 'raw')

      const result = getStatus(dir)
      expect(result.ok).toBe(true)
      const files = result.data ?? []
      expect(files.some((f) => f.path === 'tracked.txt' && f.staged && f.status === 'A')).toBe(true)
      expect(files.some((f) => f.path === 'untracked.txt' && f.untracked)).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('does not throw on a non-repo directory', () => {
    const dir = tempDir()
    try {
      const result = getStatus(dir)
      expect(result.ok).toBe(false)
      expect(typeof result.error).toBe('string')
      expect((result.error ?? '').length).toBeGreaterThan(0)
    } finally {
      cleanup(dir)
    }
  })
})

describe('stageAll', () => {
  it('stages all files and reports the count', () => {
    const dir = tempRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'a')
      writeFileSync(join(dir, 'b.txt'), 'b')
      const result = stageAll(dir)
      expect(result.ok).toBe(true)
      expect(result.data?.staged).toBe(2)
    } finally {
      cleanup(dir)
    }
  })
})

describe('commit', () => {
  it('creates a commit with the right subject and hash', () => {
    const dir = tempRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'content')
      const staged = stageAll(dir)
      expect(staged.ok).toBe(true)

      const result = commit(dir, 'feat: add a file')
      expect(result.ok).toBe(true)
      expect(result.data?.message).toBe('feat: add a file')
      expect(result.data?.hash).toMatch(/^[0-9a-f]{40}$/)

      const log = execSync('git log --oneline -n 1', { cwd: dir, encoding: 'utf-8' }) as string
      expect(log).toContain('feat: add a file')
    } finally {
      cleanup(dir)
    }
  })

  it('rejects an empty message', () => {
    const dir = tempRepo()
    try {
      const result = commit(dir, '   ')
      expect(result.ok).toBe(false)
      expect(result.error).toBe('Commit message is empty')
    } finally {
      cleanup(dir)
    }
  })

  it('accepts messages containing double quotes', () => {
    const dir = tempRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'x')
      stageAll(dir)
      const result = commit(dir, 'fix: handle "quotes"')
      expect(result.ok).toBe(true)
      expect(result.data?.message).toBe('fix: handle "quotes"')
    } finally {
      cleanup(dir)
    }
  })

  it('returns an error when there is nothing to commit', () => {
    const dir = tempRepo()
    try {
      const result = commit(dir, 'chore: nothing here')
      expect(result.ok).toBe(false)
      expect(result.error).toBeDefined()
      expect((result.error ?? '').length).toBeGreaterThan(0)
    } finally {
      cleanup(dir)
    }
  })
})

describe('shortLog', () => {
  it('returns recent commit subjects in order', () => {
    const dir = tempRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), '1')
      stageAll(dir)
      const first = commit(dir, 'chore: first')
      expect(first.ok).toBe(true)

      writeFileSync(join(dir, 'a.txt'), '2')
      stageAll(dir)
      const second = commit(dir, 'feat: second')
      expect(second.ok).toBe(true)

      const result = shortLog(dir, 5)
      expect(result.ok).toBe(true)
      expect(result.data).toHaveLength(2)
      expect(result.data?.[0]).toContain('feat: second')
      expect(result.data?.[1]).toContain('chore: first')
    } finally {
      cleanup(dir)
    }
  })
})
