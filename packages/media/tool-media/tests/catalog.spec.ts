import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogSource, capabilitiesFor, catalogURL, keyDigest, parseCatalog } from '../src/catalog.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const BODY = { version: 'v1', capabilities: [
  { id: 'a', operation: 'generate_image', model: 'second' },
  { id: 'b', operation: 'generate_image', model: 'first', default: true },
  { id: 'c', operation: 'generate_video' },
] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function source(send: typeof fetch, now = () => 0) {
  const root = mkdtempSync(join(tmpdir(), 'tool-media-catalog-'))
  roots.push(root)
  const cacheFile = join(root, 'cache', 'ov-catalog.json')
  return { cacheFile, catalog: new CatalogSource({ baseURL: 'https://gateway.example/v1/', cacheFile, fetch: send, now }) }
}

describe('capability catalog', () => {
  it('targets the catalog endpoint beside the API prefix', () => {
    expect(catalogURL('https://gateway.example/v1/')).toBe('https://gateway.example/v1/ov/capabilities')
    expect(catalogURL('https://gateway.example')).toBe('https://gateway.example/v1/ov/capabilities')
  })

  it('keeps well-formed capabilities, defaults first, and sends the key as a bearer credential', async () => {
    const send = vi.fn<typeof fetch>(async () => json(BODY))
    const { catalog } = source(send)
    const loaded = await catalog.load('sk-one')
    expect(loaded.source).toBe('live')
    expect(capabilitiesFor(loaded, 'generate_image').map(entry => entry.model)).toEqual(['first', 'second'])
    expect(capabilitiesFor(loaded, 'generate_video')).toEqual([])
    expect((send.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer sk-one')
  })

  it('serves memory within the TTL and refetches after it', async () => {
    let time = 0
    const send = vi.fn<typeof fetch>(async () => json(BODY))
    const { catalog } = source(send, () => time)
    await catalog.load('sk-one')
    time = 59_000
    await catalog.load('sk-one')
    expect(send).toHaveBeenCalledTimes(1)
    time = 61_000
    await catalog.load('sk-one')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('falls back to the disk mirror of the same key only, without storing the key', async () => {
    const { cacheFile } = source(vi.fn<typeof fetch>())
    const first = new CatalogSource({ baseURL: 'https://gateway.example/v1', cacheFile, fetch: async () => json(BODY) })
    await first.load('sk-one')
    expect(readFileSync(cacheFile, 'utf8')).toContain(keyDigest('sk-one'))
    expect(readFileSync(cacheFile, 'utf8')).not.toContain('sk-one')
    const offline = new CatalogSource({ baseURL: 'https://gateway.example/v1', cacheFile, fetch: async () => json({}, 503) })
    expect((await offline.load('sk-one')).source).toBe('cache')
    await expect(offline.load('sk-two')).rejects.toThrow(/catalog unavailable/u)
  })
})

describe('catalog parsing and mirrors', () => {
  it('rejects malformed bodies and keeps a non-string version empty', () => {
    expect(parseCatalog(null)).toBeUndefined()
    expect(parseCatalog({})).toBeUndefined()
    expect(parseCatalog({ version: 7, capabilities: [] })).toEqual({ version: '', capabilities: [] })
  })

  it('reports an unusable live body and a thrown non-Error as unavailable', async () => {
    const { catalog } = source(vi.fn<typeof fetch>(async () => json({ version: 'v1' })))
    await expect(catalog.load('sk')).rejects.toThrow('response has no capability list')
    const failing = source(vi.fn<typeof fetch>(async () => { throw 'offline' }))
    await expect(failing.catalog.load('sk')).rejects.toThrow('capability catalog unavailable: offline')
  })

  it('ignores a corrupt or foreign mirror file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-media-catalog-bad-'))
    roots.push(root)
    const cacheFile = join(root, 'cache.json')
    writeFileSync(cacheFile, 'not json')
    const bad = new CatalogSource({ baseURL: 'https://gateway.example/v1', cacheFile, fetch: vi.fn<typeof fetch>(async () => { throw new Error('offline') }) })
    await expect(bad.load('sk')).rejects.toThrow('unavailable')
    writeFileSync(cacheFile, JSON.stringify({ entries: 3 }))
    const foreign = new CatalogSource({ baseURL: 'https://gateway.example/v1', cacheFile, fetch: vi.fn<typeof fetch>(async () => { throw new Error('offline') }) })
    await expect(foreign.load('sk')).rejects.toThrow('unavailable')
  })
})

it('drops a mirror entry that no longer parses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tool-media-catalog-entry-'))
  roots.push(root)
  const cacheFile = join(root, 'cache.json')
  const digest = keyDigest('sk')
  writeFileSync(cacheFile, JSON.stringify({ version: 'v1', entries: { [digest]: { version: 1 } } }))
  const catalog = new CatalogSource({ baseURL: 'https://gateway.example/v1', cacheFile, fetch: vi.fn<typeof fetch>(async () => { throw new Error('offline') }) })
  await expect(catalog.load('sk')).rejects.toThrow('unavailable')
})
