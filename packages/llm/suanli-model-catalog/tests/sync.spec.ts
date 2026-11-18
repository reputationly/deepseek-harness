/** Catalog sync: the listing decides membership, failures keep the catalog in effect. */
import { describe, expect, it, vi } from 'vitest'
import { CatalogSync, mergeCatalog } from '../src/sync.ts'
import type { CatalogEntry } from '../src/types.ts'

function sync(options: {
  readonly answer?: () => Promise<Response>
  readonly key?: string | undefined
  readonly current?: readonly CatalogEntry[]
  readonly endpointTypes?: readonly string[]
}) {
  const written: CatalogEntry[][] = []
  const subject = new CatalogSync({
    origin: 'https://gateway.example',
    modelsPath: '/v1/models',
    timeoutMs: 1_000,
    endpointTypes: options.endpointTypes ?? ['openai'],
    send: vi.fn(async () => await (options.answer ?? (async () => json({ data: [] })))()),
    credential: async () => options.key === undefined ? 'sk-test' : options.key,
    current: () => options.current ?? [],
    write: async (models) => { written.push([...models]) },
  })
  return { subject, written }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('CatalogSync', () => {
  it('puts the listing in effect, keeping facts the gateway omits', async () => {
    const { subject, written } = sync({
      answer: async () => json({ data: [{ id: 'deepseek-v4-1-flash' }, { id: 'qwen3.8-flash-fp8' }] }),
      current: [{ id: 'qwen3.8-flash-fp8', contextWindow: 838_860, inputModalities: ['text', 'image'] }, { id: 'retired' }],
    })
    await expect(subject.refresh()).resolves.toEqual({ ok: true, count: 2, added: 1, removed: 1, changed: true })
    expect(written).toEqual([[
      { id: 'deepseek-v4-1-flash' },
      { id: 'qwen3.8-flash-fp8', contextWindow: 838_860, inputModalities: ['text', 'image'] },
    ]])
  })

  it('reports an unchanged catalog without writing it again', async () => {
    const { subject, written } = sync({
      answer: async () => json({ data: [{ id: 'a' }] }),
      current: [{ id: 'a' }],
    })
    await expect(subject.refresh()).resolves.toEqual({ ok: true, count: 1, added: 0, removed: 0, changed: false })
    expect(written).toEqual([])
  })

  it.each([
    ['no-credential', { key: '' }],
    ['unauthorized', { answer: async () => json({}, 401) }],
    ['unreachable', { answer: async () => json({}, 500) }],
    ['empty-listing', { answer: async () => json({ data: [] }) }],
    ['unreachable', { answer: async () => json({ nope: true }) }],
  ] as const)('keeps the catalog on %s', async (reason, options) => {
    const { subject, written } = sync({ ...options, current: [{ id: 'kept' }] })
    await expect(subject.refresh()).resolves.toEqual({ ok: false, reason, kept: 1 })
    expect(written).toEqual([])
  })
})

describe('mergeCatalog', () => {
  it('follows listing order and keeps the facts of entries it already knew', () => {
    expect(mergeCatalog(['b', 'a'], [{ id: 'a', contextWindow: 1 }])).toEqual([
      { id: 'b' },
      { id: 'a', contextWindow: 1 },
    ])
  })

  it('drops a repeated id and a row without one', async () => {
    const { subject, written } = sync({ answer: async () => json({ data: [{ id: 'a' }, { id: 'a' }, { nope: 1 }] }) })
    await expect(subject.refresh()).resolves.toMatchObject({ ok: true, count: 1 })
    expect(written).toEqual([[{ id: 'a' }]])
  })
})

describe('endpoint-type filtering', () => {
  it('keeps only rows that declare an asked-for endpoint type', async () => {
    const { subject, written } = sync({
      endpointTypes: ['openai'],
      answer: async () => json({
        data: [
          { id: 'chat', supported_endpoint_types: ['openai'] },
          { id: 'image', supported_endpoint_types: ['image-generation'] },
          { id: 'video', supported_endpoint_types: ['openai-video'] },
          { id: 'silent' },
        ],
      }),
    })
    await expect(subject.refresh()).resolves.toMatchObject({ ok: true, count: 2 })
    expect(written).toEqual([[{ id: 'chat' }, { id: 'silent' }]])
  })
})
