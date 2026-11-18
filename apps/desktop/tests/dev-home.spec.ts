import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { isIsolatedDevelopmentHome } from '../src/dev-home.ts'

describe('isIsolatedDevelopmentHome', () => {
  it('accepts paths under a temporary root', () => {
    expect(isIsolatedDevelopmentHome(join(tmpdir(), 'suanli-verify-home'))).toBe(true)
    expect(isIsolatedDevelopmentHome('/tmp/scratch/home')).toBe(true)
  })

  it('refuses a personal harness home', () => {
    expect(isIsolatedDevelopmentHome('/Users/someone/.dsh')).toBe(false)
    expect(isIsolatedDevelopmentHome(join(tmpdir(), '..', 'Users', 'someone', '.suanli-assistant'))).toBe(false)
  })
})
