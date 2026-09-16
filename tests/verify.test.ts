/**
 * Parsing a verification verdict is where a run's outcome is decided, and a
 * misread verdict is expensive: one run saw a non-zero exit and concluded the
 * program was broken, then spent five steps probing APIs for a cause that was in
 * the output all along. These tests pin the reading of that output.
 */

import { describe, expect, it } from 'vitest'

import {
  describeVerify,
  formatBaseline,
  summariseVerify,
  tailLines,
} from '../lib/verify.js'
import { truncateCommandOutput } from '../lib/tools.js'

const CHECK_OUTPUT = [
  '=== FIT SIGNALS ===',
  'lots of setup output nobody needs',
  'PASS  derived at least one interest  (12)',
  'PASS  no two active interests share a slug  (12)',
  'NOTE  nothing was dropped by relevance this run',
  'FAIL  no two surfaced candidates share a canonical url  (x3)',
  'FAIL  second run inserts 0 new rows  (inserted 3)',
  'PASS  validation actually ran  (3 rejected)',
].join('\n')

describe('summariseVerify', () => {
  it('counts passes, failures and notes, and names the failures', () => {
    const summary = summariseVerify('npm test', 1, CHECK_OUTPUT)
    expect(summary.passed).toBe(3)
    expect(summary.failed).toBe(2)
    expect(summary.notes).toBe(1)
    expect(summary.unstructured).toBe(false)
    expect(summary.failedChecks).toEqual([
      'no two surfaced candidates share a canonical url  (x3)',
      'second run inserts 0 new rows  (inserted 3)',
    ])
  })

  it('treats a clean run with no FAIL lines as passing', () => {
    const summary = summariseVerify('npx tsc --noEmit', 0, '')
    expect(summary.passed).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.exitCode).toBe(0)
    expect(summary.unstructured).toBe(true)
  })

  it('still fails an unstructured non-zero exit, keeping the tail as the reason', () => {
    const tscError = [
      "src/lib/feed.ts(1013,5): error TS2353: Object literal may only specify known properties",
    ].join('\n')
    const summary = summariseVerify('npx tsc --noEmit', 2, tscError)
    expect(summary.unstructured).toBe(true)
    expect(summary.failed).toBe(1)
    expect(summary.failedChecks[0]).toContain('TS2353')
  })

  it('recognises vitest failure markers', () => {
    const summary = summariseVerify('npx vitest run', 1, ' ✕ keeps the tail\n ✓ keeps the head')
    expect(summary.failed).toBe(1)
    expect(summary.failedChecks).toEqual(['keeps the tail'])
  })

  it('keeps a readable tail', () => {
    expect(tailLines('a\n\nb\nc\n', 2)).toBe('b\nc')
  })
})

describe('describeVerify', () => {
  it('names the failing checks instead of only an exit code', () => {
    const line = describeVerify(summariseVerify('npm test', 1, CHECK_OUTPUT))
    expect(line).toContain('verify FAILED')
    expect(line).toContain('3 passed')
    expect(line).toContain('2 failed')
    expect(line).toContain('failing: no two surfaced candidates')
  })

  it('says plainly when the output carried no verdict lines', () => {
    const line = describeVerify(summariseVerify('weird', 0, 'no markers here'))
    expect(line).toContain('passed')
    expect(line).toContain('unstructured')
  })
})

describe('formatBaseline', () => {
  it('tells the agent a green baseline is its contract', () => {
    const block = formatBaseline(summariseVerify('npm test', 0, 'PASS  a'))
    expect(block).toContain('Verification baseline')
    expect(block).toContain('It passes right now')
    expect(block).toContain('any failure you see later is your change')
  })

  it('names the pre-existing failures so they are not chased', () => {
    const block = formatBaseline(summariseVerify('npm test', 1, CHECK_OUTPUT))
    expect(block).toContain('FAILS right now')
    expect(block).toContain('no two surfaced candidates share a canonical url')
    expect(block).toContain('Do not try to fix unrelated pre-existing failures')
    expect(block).toContain('which failures you inherited')
  })
})

describe('truncateCommandOutput', () => {
  it('leaves short output untouched', () => {
    expect(truncateCommandOutput('PASS  a', 100)).toBe('PASS  a')
  })

  it('keeps the tail, where a run records its verdict', () => {
    const long = `HEAD-MARKER\n${'x'.repeat(5_000)}\nFAIL  the last check failed`
    const out = truncateCommandOutput(long, 1_000)
    expect(out.startsWith('HEAD-MARKER')).toBe(true)
    expect(out).toContain('FAIL  the last check failed')
    expect(out).toContain('truncated')
    // The middle is what gets dropped, and it says so.
    expect(out.length).toBeLessThan(long.length)
  })
})
