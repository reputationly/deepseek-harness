import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.ts'

describe('canvas Config', () => {
  it('applies the documented defaults', () => {
    expect(resolveConfig({})).toEqual({
      maxNodes: 10000,
      maxEdges: 20000,
      maxPromptLength: 20000,
      maxBatchOperations: 64,
      versionLimit: 8,
      textVersionLimit: 20,
      maxShotsPerStoryboard: 24,
      journalLimit: 200,
    })
  })

  it('keeps the values a deployment sets', () => {
    expect(resolveConfig({ versionLimit: 3 })).toMatchObject({ versionLimit: 3, textVersionLimit: 20 })
  })

  it('rejects a bound that cannot bound anything', () => {
    expect(() => resolveConfig({ maxNodes: 0 })).toThrow('maxNodes must be a positive integer')
    expect(() => resolveConfig({ versionLimit: 1.5 })).toThrow('versionLimit must be a positive integer')
  })

  it('exposes the same defaults through the schema', () => {
    expect(Config({})).toMatchObject({ maxNodes: 10000, maxBatchOperations: 64 })
  })
})
