import { describe, it, expect } from 'vitest'
import { checkTool, runDoctor } from '../lib/doctor.js'

describe('checkTool', () => {
  it('returns ok for `node --version`', () => {
    const result = checkTool('node', ['--version'])
    expect(result.status).toBe('ok')
    expect(result.required).toBe(true)
    expect(result.name).toBe('node --version')
  })

  it('returns fail for a nonexistent binary', () => {
    const result = checkTool('zoocode-nonexistent-bin-xyz')
    expect(result.status).toBe('fail')
    expect(result.required).toBe(true)
    expect((result.detail ?? '').length).toBeGreaterThan(0)
  })

  it('returns warn for a missing optional tool', () => {
    const result = checkTool('zoocode-nonexistent-bin-xyz', [], false)
    expect(result.status).toBe('warn')
    expect(result.required).toBe(false)
    expect(result.detail?.toLowerCase()).toContain('optional')
  })
})

describe('runDoctor', () => {
  it('returns a healthy report with all required checks ok', () => {
    const result = runDoctor()
    expect(result.ok).toBe(true)
    const report = result.data
    expect(report).toBeDefined()
    expect(report?.healthy).toBe(true)
    const required = report?.checks.filter((c) => c.required) ?? []
    expect(required.length).toBeGreaterThan(0)
    expect(required.every((c) => c.status === 'ok')).toBe(true)
  })

  it('summary counts match its checks array', () => {
    const report = runDoctor().data
    expect(report).toBeDefined()
    const checks = report?.checks ?? []
    const byStatus = checks.reduce<{ ok: number; warn: number; fail: number }>(
      (acc, c) => {
        acc[c.status] += 1
        return acc
      },
      { ok: 0, warn: 0, fail: 0 },
    )
    expect(report?.summary).toEqual(byStatus)
    const summary = report?.summary
    expect((summary?.ok ?? 0) + (summary?.warn ?? 0) + (summary?.fail ?? 0)).toBe(checks.length)
  })

  it('never throws even if a probe fails', () => {
    expect(() => runDoctor()).not.toThrow()
    const result = runDoctor()
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()
  })
})
