/** The service as the workbench sees it: startup read, status changes, durable reuse, endpoint facts. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SuanliModelCatalogService from '../src/index.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { StoredSnapshot } from '../src/domain.ts'

/** One capability entry as the gateway reports it. */
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

/** The gateway answer for one capability read. */
function catalog(capabilities: readonly unknown[], version = 'v1'): Response {
  return new Response(JSON.stringify({ version, capabilities }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** A storage-domain facility holding one generation, recording every write. */
function facility(initial?: StoredSnapshot) {
  const writes: StoredSnapshot[] = []
  const records = new Map<string, StoredSnapshot>()
  if (initial !== undefined) records.set('current', initial)
  return {
    writes,
    records,
    service: {
      open: async () => ({
        table: () => ({
          get: (key: string) => records.get(key),
          put: async (key: string, value: StoredSnapshot) => {
            records.set(key, value)
            writes.push(value)
          },
        }),
        close: async () => {},
      }),
    },
  }
}

const contexts: Context[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Boot the real service against stubbed neighbours. */
async function boot(options: {
  readonly credential?: string | undefined
  readonly answer?: () => Promise<Response>
  readonly stored?: StoredSnapshot
  readonly withStorage?: boolean
}) {
  const ctx = new Context()
  contexts.push(ctx)
  const storage = facility(options.stored)
  ctx.provide('loader', { await: async () => undefined })
  ctx.provide('credentials', {
    resolve: async (ref: string) => ref === 'AURORA_API_KEY'
      ? (options.credential === undefined ? { value: 'sk-test' } : options.credential === '' ? undefined : { value: options.credential })
      : undefined,
  })
  ctx.provide('settings', { describe: () => [], mutate: async () => {} })
  ctx.provide('typert', {})
  if (options.withStorage !== false) ctx.provide('storageDomain', storage.service)
  const send = vi.fn(async () => await (options.answer ?? (async () => catalog([ENTRY])))())
  vi.stubGlobal('fetch', send)
  await ctx.plugin(SuanliModelCatalogService, {
    baseURL: 'https://gw.example/v1',
    apiKeyEnv: 'AURORA_API_KEY',
    endpointTypes: ['openai'],
  })
  return { ctx, storage, send }
}

describe('SuanliModelCatalogService', () => {
  it('reads the catalog at startup without blocking the mount', async () => {
    const { ctx } = await boot({})
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    const media = ctx.suanliModels.media()
    expect(media.version).toBe('v1')
    expect(media.entries.map(entry => entry.model)).toEqual(['minimax-h3-image-enhanced'])
    expect(media.fetchedAt).not.toBeNull()
  })

  it('reports the endpoint a consumer must call', async () => {
    const { ctx } = await boot({})
    expect(ctx.suanliModels.endpoint()).toEqual({ baseURL: 'https://gw.example/v1', credential: 'AURORA_API_KEY' })
  })

  it('serves a stored generation before the first read finishes', async () => {
    const { ctx } = await boot({
      stored: { version: 'stored', fetchedAt: 3, payload: JSON.stringify({ version: 'stored', capabilities: [ENTRY] }) },
      // The network hangs: only the stored generation can answer.
      answer: () => new Promise<Response>(() => {}),
    })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().version).toBe('stored') })
    expect(ctx.suanliModels.media().entries).toHaveLength(1)
  })

  it('keeps the entries when a later read fails and reports why', async () => {
    let failing = false
    const { ctx } = await boot({ answer: async () => failing ? new Response('{}', { status: 500 }) : catalog([ENTRY]) })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    failing = true
    await ctx.suanliModels.refresh()
    const media = ctx.suanliModels.media()
    expect(media.status).toBe('unreachable')
    expect(media.entries).toHaveLength(1)
    expect(media.version).toBe('v1')
  })

  it('reports signed-out without contacting the gateway when the credential is missing', async () => {
    const send = vi.fn(async () => catalog([ENTRY]))
    vi.stubGlobal('fetch', send)
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('loader', { await: async () => undefined })
    ctx.provide('credentials', { resolve: async () => undefined })
    ctx.provide('settings', { describe: () => [], mutate: async () => {} })
    ctx.provide('typert', {})
    await ctx.plugin(SuanliModelCatalogService, { baseURL: 'https://gw.example/v1', apiKeyEnv: 'AURORA_API_KEY', endpointTypes: ['openai'] })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('signed-out') })
    expect(send).not.toHaveBeenCalled()
  })

  it('reads again when its own credential changes', async () => {
    const { ctx, send } = await boot({})
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    const before = send.mock.calls.length
    ctx.emit('credentials/reference-updated', credentialRef('AURORA_API_KEY'))
    await vi.waitFor(() => { expect(send.mock.calls.length).toBeGreaterThan(before) })
    // Another reference is not this service's business.
    const after = send.mock.calls.length
    ctx.emit('credentials/reference-updated', credentialRef('OTHER_KEY'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(send.mock.calls.length).toBe(after)
  })

  it('stores one generation per version and keeps them in memory without a storage domain', async () => {
    const { ctx, storage } = await boot({})
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    await ctx.suanliModels.refresh()
    // Two reads of the same version: the second must not write again.
    expect(storage.writes).toHaveLength(1)

    const memory = await boot({ withStorage: false })
    await vi.waitFor(() => { expect(memory.ctx.suanliModels.media().status).toBe('ready') })
    expect(memory.storage.writes).toHaveLength(0)
    expect(memory.ctx.suanliModels.media().entries).toHaveLength(1)
  })

  it('writes nothing and emits nothing when the model listing did not change', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const mutations: unknown[] = []
    const updates: unknown[] = []
    ctx.provide('loader', { await: async () => undefined })
    ctx.provide('credentials', { resolve: async () => ({ value: 'sk-test' }) })
    // The settings entry already carries exactly what the gateway lists.
    ctx.provide('settings', {
      describe: () => [{ ns: 'llm-deepseek', value: { models: [{ id: 'deepseek-v4-1-flash' }] } }],
      mutate: async (ns: string, ops: unknown) => { mutations.push({ ns, ops }) },
    })
    ctx.provide('typert', {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'deepseek-v4-1-flash', supported_endpoint_types: ['openai'] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await ctx.plugin(SuanliModelCatalogService, { baseURL: 'https://gw.example/v1', apiKeyEnv: 'AURORA_API_KEY', endpointTypes: ['openai'] })
    ctx.on('llm/models-updated', (provider) => { updates.push(provider) })
    await ctx.suanliModels.refresh()
    expect(mutations).toEqual([])
    expect(updates).toEqual([])
  })

  it('derives capability classes from the same entries', async () => {
    const { ctx } = await boot({
      answer: async () => catalog([
        { ...ENTRY, taskTypes: ['t2i'] },
        { ...ENTRY, id: 'generate_video:minimax-h3-2k', operation: 'generate_video', model: 'minimax-h3-2k', transport: { kind: 'videos_task' }, taskTypes: ['t2v'], default: false },
        { ...ENTRY, id: 'chat:deepseek-v4-1-flash', operation: 'chat', model: 'deepseek-v4-1-flash', transport: { kind: 'chat' }, default: true },
      ]),
    })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    expect(ctx.suanliModels.capabilities()).toEqual([
      { capability: 'chat', models: ['deepseek-v4-1-flash'] },
      { capability: 'image.generate', models: ['minimax-h3-image-enhanced'] },
      { capability: 'video.generate', models: ['minimax-h3-2k'] },
    ])
  })
})
