import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { getDefaultEnvPath, getRepoRoot, loadDotenv, parseDotenv } from '../lib/dotenv.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'zoocode-dotenv-'))
}

describe('parseDotenv', () => {
  it('parses simple key=value pairs', () => {
    expect(parseDotenv('A=1\nB=two\n')).toEqual({ A: '1', B: 'two' })
  })

  it('ignores blank lines, comments and malformed lines', () => {
    const content = ['', '   ', '# a comment', '   # indented comment', 'NOVALUE', '=nameless', 'OK=yes'].join(
      '\n',
    )
    expect(parseDotenv(content)).toEqual({ OK: 'yes' })
  })

  it('supports the export prefix', () => {
    expect(parseDotenv('export API_KEY=abc')).toEqual({ API_KEY: 'abc' })
  })

  it('strips matching double quotes and unescapes escape sequences', () => {
    expect(parseDotenv('A="line1\\nline2"\nB="say \\"hi\\""')).toEqual({
      A: 'line1\nline2',
      B: 'say "hi"',
    })
  })

  it('keeps single-quoted values literal', () => {
    expect(parseDotenv("A='line1\\nline2'")).toEqual({ A: 'line1\\nline2' })
  })

  it('drops an unquoted inline comment but preserves # inside quotes', () => {
    expect(parseDotenv('A=abc # trailing\nB="x # y"')).toEqual({ A: 'abc', B: 'x # y' })
  })

  it('allows empty values and lets the last duplicate key win', () => {
    expect(parseDotenv('A=\nB=1\nB=2')).toEqual({ A: '', B: '2' })
  })

  it('skips keys that are not valid identifiers', () => {
    expect(parseDotenv('1BAD=x\nGOOD_1=y\ndash-key=z')).toEqual({ GOOD_1: 'y' })
  })
})

describe('loadDotenv', () => {
  it('returns found:false and loads nothing when the file is missing', () => {
    const dir = tempDir()
    const result = loadDotenv({ path: join(dir, '.env'), env: {} })

    expect(result.ok).toBe(true)
    expect(result.found).toBe(false)
    expect(result.loaded).toBe(0)
    expect(result.skipped).toBe(0)

    rmSync(dir, { recursive: true, force: true })
  })

  it('loads values into the provided env object', () => {
    const dir = tempDir()
    const path = join(dir, '.env')
    writeFileSync(path, 'DEEPSEEK_API_KEY=sk-test\nOTHER=42\n', 'utf-8')

    const env: Record<string, string | undefined> = {}
    const result = loadDotenv({ path, env })

    expect(result.ok).toBe(true)
    expect(result.found).toBe(true)
    expect(result.loaded).toBe(2)
    expect(env.DEEPSEEK_API_KEY).toBe('sk-test')
    expect(env.OTHER).toBe('42')

    rmSync(dir, { recursive: true, force: true })
  })

  it('never overrides a real environment variable, but replaces a blank one', () => {
    const dir = tempDir()
    const path = join(dir, '.env')
    writeFileSync(path, 'A=from-file\nB=from-file\n', 'utf-8')

    const env: Record<string, string | undefined> = { A: 'from-env', B: '   ' }
    const result = loadDotenv({ path, env })

    expect(env.A).toBe('from-env')
    expect(env.B).toBe('from-file')
    expect(result.skipped).toBe(1)
    expect(result.loaded).toBe(1)

    rmSync(dir, { recursive: true, force: true })
  })

  it('does not touch process.env when an explicit env object is supplied', () => {
    const dir = tempDir()
    const path = join(dir, '.env')
    writeFileSync(path, 'ZOO_DOTENV_SENTINEL=1\n', 'utf-8')

    loadDotenv({ path, env: {} })

    expect(process.env.ZOO_DOTENV_SENTINEL).toBeUndefined()

    rmSync(dir, { recursive: true, force: true })
  })

  it('returns ok:false instead of throwing when the path cannot be read', () => {
    const dir = tempDir()
    const result = loadDotenv({ path: dir, env: {} }) // a directory → EISDIR

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Failed to load')

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('escape hatches', () => {
  it('skips loading entirely when ZOO_NO_DOTENV is truthy', () => {
    const dir = tempDir()
    const path = join(dir, '.env')
    writeFileSync(path, 'A=from-file\n', 'utf-8')

    const env: Record<string, string | undefined> = { ZOO_NO_DOTENV: '1' }
    const skippedResult = loadDotenv({ env })

    expect(skippedResult.ok).toBe(true)
    expect(skippedResult.disabled).toBe(true)
    expect(skippedResult.found).toBe(false)
    expect(env.A).toBeUndefined()

    // An explicit path always wins over the opt-out.
    const forced = loadDotenv({ path, env })
    expect(forced.disabled).toBe(false)
    expect(forced.found).toBe(true)
    expect(env.A).toBe('from-file')

    rmSync(dir, { recursive: true, force: true })
  })

  it('reads ZOO_ENV_FILE instead of the default location', () => {
    const dir = tempDir()
    const path = join(dir, 'custom.env')
    writeFileSync(path, 'A=custom\n', 'utf-8')

    const env: Record<string, string | undefined> = { ZOO_ENV_FILE: path }
    const result = loadDotenv({ env })

    expect(result.path).toBe(path)
    expect(result.found).toBe(true)
    expect(env.A).toBe('custom')

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('paths', () => {
  it('resolves the repo root as the parent of lib/', () => {
    const root = getRepoRoot()

    expect(getDefaultEnvPath()).toBe(join(root, '.env'))
    expect(root.toLowerCase()).toContain('zoocode')
  })
})
