// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { BrandMark, BrandName } from '../src/client/Brand.tsx'
import { apply as hostApply } from '../src/index.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const HOLES = ['sidebar.brand.mark', 'sidebar.brand.name'] as const

const HERO_HOLE = 'conversation.hero.brand.mark'

/**
 * Build a context holding the slot registry with the brand holes declared.
 * @param declare - whether the holes exist before the plugin loads.
 * @returns The context, its registry, and a redeclaration helper.
 */
async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries([...HOLES, HERO_HOLE].map(name => [name, { kind: 'single' as const, scope: 'root' as const }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles }
}

describe('product brand plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the slot service it uses', () => {
    expect(inject).toEqual(['slots'])
  })

  it('fills every brand hole in any build profile', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'local')
    const subject = await bench()
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(subject.slots.entries(hole)).toHaveLength(1)
    expect(subject.slots.entries(HERO_HOLE)).toHaveLength(1)
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

  it('renders the wordmark fallback and the mark at the requested size', () => {
    // The build inlines `DSH_CLIENT_TITLE` at import time, so a spec sees the fallback.
    const name = render(<BrandName />)
    expect(name.container.textContent).toBe('Aurora')
    name.unmount()

    const mark = render(<BrandMark size={34} className="hero" />)
    expect(mark.container.querySelector('img')?.getAttribute('width')).toBe('34')
    expect(mark.container.querySelector('img')?.className).toBe('hero')
    mark.rerender(<BrandMark size={24} />)
    expect(mark.container.querySelector('img')?.getAttribute('width')).toBe('24')
  })
})
