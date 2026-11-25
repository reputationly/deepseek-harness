/** Durable and in-memory catalog stores: one generation survives, a broken payload reads as absent. */
import { describe, expect, it } from 'vitest'
import { decodeCatalog } from '../src/media.ts'
import { domainCatalogStore, memoryCatalogStore, type StoredSnapshot } from '../src/domain.ts'
import type { MediaCatalogRecord } from '../src/media-sync.ts'

/** One catalog entry as the gateway reports it. */
const ENTRY = {
  id: 'generate_image:minimax-h3-image-enhanced',
  operation: 'generate_image',
  model: 'minimax-h3-image-enhanced',
  displayName: { zh: '增强', en: 'Enhanced' },
  description: { zh: '', en: '' },
  transport: { kind: 'images' },
  limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 },
  default: true,
}

/** A record the store can hold. */
function record(overrides: Partial<MediaCatalogRecord> = {}): MediaCatalogRecord {
  const decoded = decodeCatalog({ version: 'v1', capabilities: [ENTRY] })
  if (decoded === undefined) throw new Error('fixture catalog does not decode')
  return { version: 'v1', fetchedAt: 7, entries: decoded.entries, ...overrides }
}

/** In-memory table stand-in for the opened domain table. */
function table(initial?: StoredSnapshot) {
  const records = new Map<string, StoredSnapshot>()
  if (initial !== undefined) records.set('current', initial)
  return {
    records,
    get: (key: string) => records.get(key),
    put: async (key: string, value: StoredSnapshot) => { records.set(key, value) },
  }
}

describe('domainCatalogStore', () => {
  it('keeps the generation it wrote and reads it back decoded', async () => {
    const opened = table()
    const store = domainCatalogStore(opened)
    await store.write(record())
    expect(store.read()).toMatchObject({ version: 'v1', fetchedAt: 7 })
    expect(store.read()?.entries).toHaveLength(1)
    expect(store.read()?.entries[0]?.model).toBe('minimax-h3-image-enhanced')
  })

  it('reads an empty table as absent', () => {
    expect(domainCatalogStore(table()).read()).toBeUndefined()
  })

  it('reads a payload it can no longer decode as absent instead of failing', () => {
    const store = domainCatalogStore(table({ version: 'v1', fetchedAt: 1, payload: 'not json' }))
    expect(store.read()).toBeUndefined()
  })

  it('reads a payload without a capability list as absent', () => {
    const store = domainCatalogStore(table({ version: 'v1', fetchedAt: 1, payload: JSON.stringify({ nope: true }) }))
    expect(store.read()).toBeUndefined()
  })

  it('reads a generation with no entries as absent', () => {
    const store = domainCatalogStore(table({ version: 'v1', fetchedAt: 1, payload: JSON.stringify({ version: 'v1', capabilities: [] }) }))
    expect(store.read()).toBeUndefined()
  })
})

describe('memoryCatalogStore', () => {
  it('keeps the generation for this process only', async () => {
    const store = memoryCatalogStore()
    expect(store.read()).toBeUndefined()
    await store.write(record({ version: 'v2' }))
    expect(store.read()?.version).toBe('v2')
  })
})
