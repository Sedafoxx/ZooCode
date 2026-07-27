import { describe, it, expect } from 'vitest'
import { ensureDir, writeFile, collectFiles, scaffoldFromTemplate, getProjectSummary } from '../lib/files.js'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zoocode-test-'))
  return dir
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

describe('ensureDir', () => {
  it('creates a directory if it does not exist', () => {
    const dir = tempDir()
    const testDir = join(dir, 'a', 'b', 'c')
    expect(existsSync(testDir)).toBe(false)
    ensureDir(testDir)
    expect(existsSync(testDir)).toBe(true)
    cleanup(dir)
  })

  it('does not throw if directory already exists', () => {
    const dir = tempDir()
    ensureDir(dir)
    expect(() => ensureDir(dir)).not.toThrow()
    cleanup(dir)
  })
})

describe('writeFile', () => {
  it('writes a file and creates parent directories', () => {
    const dir = tempDir()
    const filePath = join(dir, 'sub', 'test.txt')
    writeFile(filePath, 'hello')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('hello')
    cleanup(dir)
  })
})

describe('collectFiles', () => {
  it('collects all files recursively, skipping node_modules and .git', () => {
    const dir = tempDir()
    writeFile(join(dir, 'src', 'index.ts'), '')
    writeFile(join(dir, 'src', 'util.ts'), '')
    writeFile(join(dir, 'node_modules', 'dep', 'index.ts'), '')
    writeFile(join(dir, '.git', 'HEAD'), '')

    const files = collectFiles(dir)
    const relative = files.map((f) => f.replace(dir, '')).sort()
    expect(relative).toEqual(['\\src\\index.ts', '\\src\\util.ts'])
    cleanup(dir)
  })

  it('filters by extension', () => {
    const dir = tempDir()
    writeFile(join(dir, 'a.ts'), '')
    writeFile(join(dir, 'b.js'), '')
    writeFile(join(dir, 'c.ts'), '')

    const tsFiles = collectFiles(dir, '.ts')
    const relative = tsFiles.map((f) => f.replace(dir, '')).sort()
    expect(relative).toEqual(['\\a.ts', '\\c.ts'])
    cleanup(dir)
  })
})

describe('scaffoldFromTemplate', () => {
  it('writes multiple files into a target directory', () => {
    const dir = tempDir()
    const outDir = join(dir, 'output')
    scaffoldFromTemplate(outDir, [
      { path: 'src/index.ts', content: '// hello' },
      { path: 'README.md', content: '# Readme' },
    ])

    expect(existsSync(join(outDir, 'src', 'index.ts'))).toBe(true)
    expect(readFileSync(join(outDir, 'src', 'index.ts'), 'utf-8')).toBe('// hello')
    expect(readFileSync(join(outDir, 'README.md'), 'utf-8')).toBe('# Readme')
    cleanup(dir)
  })
})

describe('getProjectSummary', () => {
  it('returns correct file counts and line counts', () => {
    const dir = tempDir()
    writeFile(join(dir, 'a.ts'), 'line1\nline2\n')
    writeFile(join(dir, 'b.ts'), 'line1\n')
    writeFile(join(dir, 'c.json'), '{}')

    const summary = getProjectSummary(dir)
    expect(summary.files).toBe(3)
    // 'line1\nline2\n'.split('\n').length = 3
    // 'line1\n'.split('\n').length = 2
    // '{}'.split('\n').length = 1
    expect(summary.lines).toBe(6)
    expect(summary.extensions['ts']).toBe(2)
    expect(summary.extensions['json']).toBe(1)
    cleanup(dir)
  })
})
