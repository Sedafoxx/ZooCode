import { describe, it, expect } from 'vitest'
import {
  listTemplates,
  getTemplate,
  resolveTemplateFiles,
  DEFAULT_TEMPLATE,
} from '../lib/templates.js'

describe('templates registry', () => {
  it('listTemplates returns at least 2 templates including base', () => {
    const templates = listTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(2)
    const names = templates.map((t) => t.name)
    expect(names).toContain('base')
    for (const summary of templates) {
      expect(typeof summary.name).toBe('string')
      expect(typeof summary.description).toBe('string')
    }
  })

  it('getTemplate resolves base case-insensitively and tolerates whitespace', () => {
    for (const name of ['base', 'BASE', 'Base', ' base ', 'BASE ', ' base']) {
      const result = getTemplate(name)
      expect(result.ok).toBe(true)
      expect(result.data?.name).toBe('base')
    }
  })

  it('getTemplate returns {ok:false} for an unknown name', () => {
    const result = getTemplate('does-not-exist')
    expect(result.ok).toBe(false)
    expect(result.data).toBeUndefined()
    expect(typeof result.error).toBe('string')
  })

  it('resolveTemplateFiles("base", "demo") returns the expected 5 files', () => {
    const result = resolveTemplateFiles('base', 'demo')
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()
    expect(result.data!.map((f) => f.path)).toEqual([
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'README.md',
      'src/index.ts',
    ])
    const pkg = JSON.parse(result.data!.find((f) => f.path === 'package.json')!.content) as {
      name: string
      scripts: Record<string, string>
    }
    expect(pkg.name).toBe('demo')
    expect(pkg.scripts.lint).toBe('oxlint')
  })

  it('resolveTemplateFiles("lib", "mylib") package.json includes a test script', () => {
    const result = resolveTemplateFiles('lib', 'mylib')
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()
    const pkg = JSON.parse(result.data!.find((f) => f.path === 'package.json')!.content) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.test).toBeTruthy()
    expect(pkg.scripts.build).toBeTruthy()
    expect(pkg.scripts.lint).toBeTruthy()
  })

  it('resolveTemplateFiles returns {ok:false} for an unknown template', () => {
    const result = resolveTemplateFiles('nope', 'demo')
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('DEFAULT_TEMPLATE is "base"', () => {
    expect(DEFAULT_TEMPLATE).toBe('base')
  })
})
