import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  loadConfig,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_MAX_STEPS,
  DEFAULT_CONCURRENCY,
  DEFAULT_TEMPERATURE,
} from '../lib/config.js'

const KEYS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'ZOO_MAX_STEPS',
  'ZOO_CONCURRENCY',
  'ZOO_TEMPERATURE',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('loadConfig', () => {
  it('falls back to defaults when only the api key is set', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'

    const result = loadConfig()

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.data).toEqual({
      apiKey: 'sk-test',
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      maxSteps: DEFAULT_MAX_STEPS,
      concurrency: DEFAULT_CONCURRENCY,
      temperature: DEFAULT_TEMPERATURE,
    })
  })

  it('reads env overrides, trimming and parsing values', () => {
    process.env.DEEPSEEK_API_KEY = '  sk-env  '
    process.env.DEEPSEEK_BASE_URL = ' https://api.example.test '
    process.env.DEEPSEEK_MODEL = 'deepseek-reasoner'
    process.env.ZOO_MAX_STEPS = '7'
    process.env.ZOO_CONCURRENCY = '5'
    process.env.ZOO_TEMPERATURE = '0.9'

    const result = loadConfig()

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      apiKey: 'sk-env',
      baseUrl: 'https://api.example.test',
      model: 'deepseek-reasoner',
      maxSteps: 7,
      concurrency: 5,
      temperature: 0.9,
    })
  })

  it('lets overrides beat env values', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env'
    process.env.DEEPSEEK_BASE_URL = 'https://env.example.test'
    process.env.DEEPSEEK_MODEL = 'env-model'
    process.env.ZOO_MAX_STEPS = '7'
    process.env.ZOO_CONCURRENCY = '5'
    process.env.ZOO_TEMPERATURE = '0.9'

    const result = loadConfig({
      apiKey: 'sk-override',
      baseUrl: 'https://override.example.test',
      model: 'override-model',
      maxSteps: 3,
      concurrency: 1,
      temperature: 0,
    })

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({
      apiKey: 'sk-override',
      baseUrl: 'https://override.example.test',
      model: 'override-model',
      maxSteps: 3,
      concurrency: 1,
      temperature: 0,
    })
  })

  it('accepts an api key supplied only by overrides', () => {
    const result = loadConfig({ apiKey: 'sk-only-override' })

    expect(result.ok).toBe(true)
    expect(result.data?.apiKey).toBe('sk-only-override')
  })

  it('returns { ok: false, error } when no api key is resolvable', () => {
    const result = loadConfig()

    expect(result.ok).toBe(false)
    expect(result.data).toBeUndefined()
    expect(result.error).toBeTruthy()
    expect(result.error).toContain('DEEPSEEK_API_KEY')
  })

  it('treats empty/whitespace env values as absent', () => {
    process.env.DEEPSEEK_API_KEY = '   '
    process.env.DEEPSEEK_MODEL = '  '

    const missing = loadConfig()
    expect(missing.ok).toBe(false)

    process.env.DEEPSEEK_API_KEY = 'sk-test'
    const result = loadConfig()
    expect(result.ok).toBe(true)
    expect(result.data?.model).toBe(DEFAULT_MODEL)
  })

  it('ignores malformed numeric env values instead of throwing', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    process.env.ZOO_MAX_STEPS = 'not-a-number'
    process.env.ZOO_CONCURRENCY = '-4'
    process.env.ZOO_TEMPERATURE = ''

    const result = loadConfig()

    expect(result.ok).toBe(true)
    expect(result.data?.maxSteps).toBe(DEFAULT_MAX_STEPS)
    expect(result.data?.concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(result.data?.temperature).toBe(DEFAULT_TEMPERATURE)
  })

  it('never throws, even for nonsense overrides', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'

    expect(() => loadConfig()).not.toThrow()
    expect(() =>
      loadConfig({ temperature: Number.NaN, maxSteps: Number.POSITIVE_INFINITY }),
    ).not.toThrow()
    expect(() =>
      loadConfig({ apiKey: undefined, baseUrl: undefined, model: undefined }),
    ).not.toThrow()
    expect(() => loadConfig({ apiKey: '' })).not.toThrow()

    const result = loadConfig({ temperature: Number.NaN, maxSteps: Number.POSITIVE_INFINITY })
    expect(result.ok).toBe(true)
    expect(result.data?.temperature).toBe(DEFAULT_TEMPERATURE)
    expect(result.data?.maxSteps).toBe(DEFAULT_MAX_STEPS)
  })
})
