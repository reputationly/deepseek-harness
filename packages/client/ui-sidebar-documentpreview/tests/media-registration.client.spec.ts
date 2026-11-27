/** Media metadata, keyed slot, dictionary, and disposal registration. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { MediaBody } from '../src/client/media/MediaBody.tsx'
import { apply, MEDIA_BODY_ID, MEDIA_EXTENSIONS, mediaBodyDefinition } from '../src/client/media/index.ts'
import { en, ja, zh, es, fr, de, ru, pt } from '../src/client/media/locales.ts'

let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined })

describe('media registration', () => {
  it('claims common audio and video suffixes as a builtin complete-byte renderer without wrap', () => {
    const title = vi.fn(() => 'localized media')
    const definition = mediaBodyDefinition(title)
    expect(definition).toMatchObject({
      id: MEDIA_BODY_ID,
      extensions: MEDIA_EXTENSIONS,
      binaryExtensions: MEDIA_EXTENSIONS,
      priority: 'builtin',
      title,
      loading: 'bytes-complete',
      wrap: false,
    })
    expect(title).not.toHaveBeenCalled()
    expect(definition.title()).toBe('localized media')
  })

  it('registers its dictionary and matching keyed body, then removes every contribution', async () => {
    const ctx = new Context()
    const registry = new DocumentPreviewRegistry()
    const dictionaries = new Map<string, unknown>()
    const bodies = new Map<string, unknown>()
    const register = vi.fn((options: { key: string }, body: unknown) => {
      bodies.set(options.key, body)
      return () => { bodies.delete(options.key) }
    })
    ctx.provide('documentPreviews', registry)
    ctx.provide('slots', { inject: (_key: string, callback: () => () => void) => callback(), register } as never)
    ctx.provide('locale', {
      bind: () => (key: keyof typeof en) => en[key],
      register: (name: string, value: unknown) => {
        dictionaries.set(name, value)
        return () => { dictionaries.delete(name) }
      },
    } as never)
    const fiber = ctx.plugin({ apply })
    dispose = async () => { await fiber.dispose() }
    await fiber.await()
    for (const extension of MEDIA_EXTENSIONS) {
      expect(registry.candidates(`MEDIA.${extension}`).map(entry => entry.id)).toEqual([MEDIA_BODY_ID])
    }
    expect(registry.getSnapshot()[0]?.title()).toBe(en.title)
    expect(dictionaries.get('sidebarMedia')).toEqual({ zh, en, ja, es, fr, de, ru, pt })
    expect(register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      name: 'sidebar.right.tab.document', key: MEDIA_BODY_ID, locale: 'sidebarMedia',
    }), MediaBody)
    await dispose()
    expect(registry.getSnapshot()).toEqual([])
    expect(bodies.size).toBe(0)
    expect(dictionaries.size).toBe(0)
  })
})
