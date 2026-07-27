import { describe, it, expect } from 'vitest'

// Logger functions are side-effectful (console.log), so we just verify they
// exist and are callable without throwing.
describe('logger', () => {
  it('exports all expected functions', async () => {
    const logger = await import('../lib/logger.js')
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.success).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(typeof logger.step).toBe('function')
    expect(typeof logger.dim).toBe('function')
    expect(typeof logger.header).toBe('function')
  })

  it('logger functions do not throw', async () => {
    const log = console.log
    console.log = () => {} // silence during test
    const logger = await import('../lib/logger.js')
    expect(() => logger.info('test')).not.toThrow()
    expect(() => logger.success('test')).not.toThrow()
    expect(() => logger.warn('test')).not.toThrow()
    expect(() => logger.error('test')).not.toThrow()
    expect(() => logger.step('test')).not.toThrow()
    expect(() => logger.dim('test')).not.toThrow()
    expect(() => logger.header('test')).not.toThrow()
    console.log = log
  })
})
