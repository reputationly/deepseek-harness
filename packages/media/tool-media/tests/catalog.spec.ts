import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogSource, capabilitiesFor, catalogURL, keyDigest } from '../src/catalog.ts'

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
