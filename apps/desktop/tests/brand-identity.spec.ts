import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandUrlScheme, isolateBrandHome } from '../src/brand-identity.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe('isolateBrandHome', () => {
  const home = '/os/home'

  it('leaves the environment alone when the build inlined no product home', () => {
    const environment: NodeJS.ProcessEnv = { DSH_HOME: '/u/.dsh' }
    expect(isolateBrandHome(environment, true, home)).toBeUndefined()
    expect(environment).toEqual({ DSH_HOME: '/u/.dsh' })
  })

  it('replaces an inherited dsh home when packaged', () => {
    vi.stubEnv('DSH_BRAND_HOME_DIR', '.suanli-assistant')
    const environment: NodeJS.ProcessEnv = { DSH_HOME: '/u/.dsh', DSH_AGENTS_HOME: '/u/.agents' }
    const dshHome = join(home, '.suanli-assistant')
    expect(isolateBrandHome(environment, true, home)).toEqual({ dshHome, agentsHome: join(dshHome, 'agents') })
    expect(environment.DSH_HOME).toBe(dshHome)
    expect(environment.DSH_AGENTS_HOME).toBe(join(dshHome, 'agents'))
  })

  it('keeps an inherited dsh home when unpackaged', () => {
    vi.stubEnv('DSH_BRAND_HOME_DIR', '.suanli-assistant')
    const environment: NodeJS.ProcessEnv = { DSH_HOME: '/dev/home' }
    expect(isolateBrandHome(environment, false, home)).toEqual({ dshHome: '/dev/home', agentsHome: join('/dev/home', 'agents') })
    expect(environment.DSH_AGENTS_HOME).toBe(join('/dev/home', 'agents'))
  })

  it('keeps an inherited agents home when unpackaged', () => {
    vi.stubEnv('DSH_BRAND_HOME_DIR', '.suanli-assistant')
    const environment: NodeJS.ProcessEnv = { DSH_AGENTS_HOME: '/dev/agents' }
    const dshHome = join(home, '.suanli-assistant')
    expect(isolateBrandHome(environment, false, home)).toEqual({ dshHome, agentsHome: '/dev/agents' })
    expect(environment.DSH_HOME).toBe(dshHome)
  })

  it('treats a blank inherited dsh home as absent when unpackaged', () => {
    vi.stubEnv('DSH_BRAND_HOME_DIR', '.suanli-assistant')
    const environment: NodeJS.ProcessEnv = { DSH_HOME: '  ' }
    const dshHome = join(home, '.suanli-assistant')
    expect(isolateBrandHome(environment, false, home)).toEqual({ dshHome, agentsHome: join(dshHome, 'agents') })
    expect(environment.DSH_HOME).toBe(dshHome)
  })
})

describe('brandUrlScheme', () => {
  it('falls back to the upstream scheme without an inlined value', () => {
    expect(brandUrlScheme()).toBe('dsh')
  })

  it('returns the inlined product scheme', () => {
    vi.stubEnv('DSH_BRAND_URL_SCHEME', 'suanli-assistant')
    expect(brandUrlScheme()).toBe('suanli-assistant')
  })
})
