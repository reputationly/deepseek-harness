// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { BrandMark, BrandName } from '../src/client/Brand.tsx'
import { ConnectionPill } from '../src/client/ConnectionPill.tsx'
import type { GatewayStatus } from '@deepseek-ai/dsh-api-gateway-status/types'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const HOLES = ['sidebar.brand.mark', 'sidebar.brand.name'] as const

const HERO_HOLE = 'conversation.hero.brand.mark'

/** The Models-settings seat this plugin fills with the catalog-refresh row. */
const CATALOG_HOLE = 'settings.models.footer'

const dictionary = (key: string): string => key

const CONNECTED = async (): Promise<GatewayStatus> => ({ state: 'connected', code: 'connected' })

/**
 * Build a context holding the slot registry, the locale registry, and the gateway namespace.
 * @param declare - whether the brand holes exist before the plugin loads.
 * @returns The context, its registry, and a redeclaration helper.
 */
async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', { register: () => () => {} } as never)
  ctx.provide('remote', {} as never)
  ctx.provide('remote.workspaceFiles', {} as never)
  ctx.provide('remote.gatewayStatus', {
    read: async () => ({ ok: true, value: { state: 'connected', code: 'connected' } }),
    refresh: async () => ({ ok: true, value: { state: 'connected', code: 'connected' } }),
  } as never)
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: {
      'sidebar.brand.mark': { kind: 'single' as const, scope: 'root' as const },
      'sidebar.brand.name': { kind: 'single' as const, scope: 'root' as const },
      'conversation.hero.brand.mark': { kind: 'single' as const, scope: 'root' as const },
      'settings.models.footer': { kind: 'list' as const, scope: 'root' as const },
      'settings.models.provider-card': { kind: 'keyed' as const, scope: 'root' as const },
      'tool.call.toolview': { kind: 'keyed' as const, scope: 'session' as const },
    },
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles }
}

describe('product brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    // The gateway namespace stays optional: a deployment without the row renders the light as not connected.
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.workspaceFiles'])
  })

  it('fills every brand hole', async () => {
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
    expect(subject.slots.entries(HERO_HOLE)).toHaveLength(1)
    expect(subject.slots.entries(CATALOG_HOLE)).toHaveLength(1)
    expect(subject.slots.entries('settings.models.provider-card')).toHaveLength(1)
    // The blank home keeps its frame slot free for other occupants.
    expect(subject.slots.entries('conversation.hero.frame')).toHaveLength(0)
  })

  it('installs before or after the declarations and removes every occupant on teardown', async () => {
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    before.disposeHoles?.()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)

    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('fills the image, video, and music tool cards and removes them on teardown', async () => {
    const subject = await bench()
    const fiber = subject.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(subject.slots.entries('tool.call.toolview').map(entry => entry.options.key).sort())
      .toEqual(['generate_image', 'generate_music', 'generate_speech', 'generate_video'])
    await fiber.dispose()
    expect(subject.slots.entries('tool.call.toolview')).toHaveLength(0)
  })

  it('renders the wordmark with the connection light after it', async () => {
    // The build inlines `DSH_CLIENT_TITLE` at import time, so a spec sees the fallback.
    const view = render(<BrandName read={CONNECTED} refresh={CONNECTED} t={dictionary} />)
    expect(view.container.textContent).toContain('Aurora')
    await vi.waitFor(() => { expect(view.container.textContent).toContain('connected') })
  })

  it('renders the mark at the requested size', () => {
    const mark = render(<BrandMark size={34} className="hero" />)
    expect(mark.container.querySelector('img')?.getAttribute('width')).toBe('34')
    expect(mark.container.querySelector('img')?.className).toBe('hero')
    mark.rerender(<BrandMark size={24} />)
    expect(mark.container.querySelector('img')?.getAttribute('width')).toBe('24')
  })

  it('names the failure in the light tooltip', async () => {
    const refresh = async (): Promise<GatewayStatus> => ({ state: 'disconnected', code: 'key-rejected' })
    const view = render(<ConnectionPill read={refresh} refresh={refresh} t={dictionary} />)
    await vi.waitFor(() => { expect(view.container.querySelector('[data-state]')?.getAttribute('title')).toBe('reason.key-rejected') })
  })
})
