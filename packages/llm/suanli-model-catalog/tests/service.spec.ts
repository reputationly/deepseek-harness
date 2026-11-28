/** The service as the workbench sees it: startup read, status changes, durable reuse, roles, endpoint facts. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SuanliModelCatalogService from '../src/index.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { StoredSnapshot } from '../src/domain.ts'
import { hilo, IMAGE, json, TEXT } from './hilo-fixture.ts'

/** A storage-domain facility holding one catalog generation, recording every catalog write. */
function facility(initial?: StoredSnapshot) {
  const writes: StoredSnapshot[] = []
  const domains = new Map<string, Map<string, unknown>>()
  const records = new Map<string, StoredSnapshot>()
  if (initial !== undefined) records.set('current', initial)
  domains.set('suanli_media_catalog:snapshot', records)
  return {
    writes,
    records,
    domains,
    service: {
      open: async (domain: { name: string }) => ({
        table: (name: string) => {
          const key = `${domain.name}:${name}`
          const rows = domains.get(key) ?? new Map<string, unknown>()
          domains.set(key, rows)
          return {
            get: (row: string) => rows.get(row),
            put: async (row: string, value: unknown) => {
              rows.set(row, value)
              if (domain.name === 'suanli_media_catalog') writes.push(value as StoredSnapshot)
            },
          }
        },
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
  readonly answer?: (url: string) => Promise<Response>
  readonly stored?: StoredSnapshot
  readonly withStorage?: boolean
  readonly models?: readonly unknown[]
  readonly pinned?: boolean
}) {
  const ctx = new Context()
  contexts.push(ctx)
  const storage = facility(options.stored)
  ctx.provide('loader', { await: async () => undefined })
  let credential = options.credential === undefined ? 'sk-test' : options.credential
  const credentialWrites: string[] = []
  ctx.provide('credentials', {
    resolve: async (ref: string) => ref === 'AURORA_API_KEY'
      ? (credential === '' ? undefined : { value: credential })
      : undefined,
    set: async (ref: string, value: string) => { if (ref === 'AURORA_API_KEY') { credential = value; credentialWrites.push(value) } },
  })
  const mutations: unknown[] = []
  let models = options.models
  ctx.provide('settings', {
    describe: () => models === undefined ? [] : [{ ns: 'llm-deepseek', value: { models } }],
    mutate: async (ns: string, ops: readonly { value: readonly unknown[] }[]) => {
      if (options.pinned === true) throw new Error(`Configuration for "${ns}" is overridden by a home patch`)
      mutations.push({ ns, ops })
      models = ops[0]?.value
    },
  })
  ctx.provide('typert', {})
  if (options.withStorage !== false) ctx.provide('storageDomain', storage.service)
  const send = vi.fn(async (url: string, _init?: RequestInit) => await (options.answer ?? (async () => json(hilo())))(url))
  vi.stubGlobal('fetch', send)
  const updates: unknown[] = []
  ctx.on('llm/models-updated', (provider) => { updates.push(provider) })
  // Entries a listener reads when the catalog announces a change.
  const announced: number[] = []
  ctx.on('suanli-model-catalog/media-updated', () => {
    const service = ctx.get('suanliModels') as { media: () => { entries: readonly unknown[] } } | undefined
    announced.push(service?.media().entries.length ?? -1)
  })
  await ctx.plugin(SuanliModelCatalogService, { baseURL: 'https://gw.example/v1', apiKeyEnv: 'AURORA_API_KEY' })
  return { ctx, storage, send, mutations, updates, announced, credentialWrites }
}

/** One stored generation carrying the fixture image entry. */
const STORED_ENTRY = {
  id: 'generate_image:minimax-h3-image', operation: 'generate_image', model: 'minimax-h3-image',
  displayName: { zh: 'H3', en: 'H3' }, description: { zh: '', en: '' }, transport: { kind: 'images' },
  limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 }, default: true,
}

describe('SuanliModelCatalogService', () => {
  it('reads the Hilo catalog at startup without the key and without blocking the mount', async () => {
    const { ctx, send } = await boot({})
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    const media = ctx.suanliModels.media()
    expect(media.version).toBe('v1')
    expect(media.entries.map(entry => entry.model)).toEqual(['minimax-h3-image', 'minimax-h3-2k', 'minimax-music3'])
    expect(media.fetchedAt).not.toBeNull()
    // Only the catalog is read; neither the old capability view nor the model listing.
    expect(send.mock.calls.map(([url]) => url)).toEqual(['https://gw.example/api/v1/models/catalog'])
    expect(JSON.stringify(send.mock.calls[0]?.[1]?.headers)).not.toContain('sk-test')
  })

  it('reports the endpoint a consumer must call', async () => {
    const { ctx } = await boot({})
    expect(ctx.suanliModels.endpoint()).toEqual({ baseURL: 'https://gw.example/v1', credential: 'AURORA_API_KEY' })
  })

  it('serves a stored generation before the first read finishes', async () => {
    const { ctx } = await boot({
      stored: { version: 'stored', fetchedAt: 3, payload: JSON.stringify({ version: 'stored', capabilities: [STORED_ENTRY] }) },
      // The network hangs: only the stored generation can answer.
      answer: () => new Promise<Response>(() => {}),
    })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().version).toBe('stored') })
    expect(ctx.suanliModels.media().entries).toHaveLength(1)
  })

  it('announces the media catalog when the profile pins the chat models', async () => {
    const { ctx, announced } = await boot({ pinned: true })
    await vi.waitFor(() => { expect(announced).toEqual([3]) })
    expect(ctx.suanliModels.media().status).toBe('ready')
  })

  it('announces a stored generation that a listener can already read', async () => {
    const { announced } = await boot({
      stored: { version: 'stored', fetchedAt: 3, payload: JSON.stringify({ version: 'stored', capabilities: [STORED_ENTRY] }) },
      answer: () => new Promise<Response>(() => {}),
    })
    await vi.waitFor(() => { expect(announced).toEqual([1]) })
  })

  it('keeps the entries when a later read fails and reports why', async () => {
    let failing = false
    const { ctx } = await boot({ answer: async () => failing ? new Response('{}', { status: 500 }) : json(hilo()) })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    failing = true
    await expect(ctx.suanliModels.refresh()).resolves.toMatchObject({ ok: false, reason: 'unreachable' })
    const media = ctx.suanliModels.media()
    expect(media.status).toBe('unreachable')
    expect(media.entries).toHaveLength(3)
    expect(media.version).toBe('v1')
  })

  it('shows the catalog to a signed-out user and reports signed-out', async () => {
    const { ctx, send } = await boot({ credential: '' })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('signed-out') })
    expect(send).toHaveBeenCalled()
    expect(ctx.suanliModels.media().entries).toHaveLength(3)
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
    expect(memory.ctx.suanliModels.media().entries).toHaveLength(3)
  })

  it('puts the text section in the chat catalog, keeping facts the catalog omits', async () => {
    const { ctx, mutations, updates } = await boot({ models: [{ id: 'deepseek-v4-1-flash', contextWindow: 1_000_000 }, { id: 'retired' }] })
    await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]).toEqual({
      ns: 'llm-deepseek',
      ops: [{ op: 'set', path: ['models'], value: [
        { id: 'deepseek-v4-1-flash', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
        { id: 'qwen3.8-flash-fp8', inputModalities: ['text', 'image'] },
      ] }],
    })
    expect(updates).toEqual(['deepseek-official'])
    await expect(ctx.suanliModels.refresh()).resolves.toMatchObject({ ok: true, count: 2, changed: false })
  })

  it('writes nothing and emits nothing when the chat models did not change', async () => {
    const { ctx, mutations, updates } = await boot({ models: [
      { id: 'deepseek-v4-1-flash', inputModalities: ['text', 'image'] },
      { id: 'qwen3.8-flash-fp8', inputModalities: ['text', 'image'] },
    ] })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    await ctx.suanliModels.refresh()
    expect(mutations).toEqual([])
    expect(updates).toEqual([])
  })

  it('derives capability classes, chat and vision included, from the same catalog', async () => {
    const { ctx } = await boot({})
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    expect(ctx.suanliModels.capabilities()).toEqual([
      { capability: 'chat', models: ['deepseek-v4-1-flash', 'qwen3.8-flash-fp8'] },
      { capability: 'vision.image', models: ['deepseek-v4-1-flash', 'qwen3.8-flash-fp8'] },
      { capability: 'vision.video', models: ['qwen3.8-flash-fp8'] },
      { capability: 'image.generate', models: ['minimax-h3-image'] },
      { capability: 'image.edit', models: ['minimax-h3-image'] },
      { capability: 'video.generate', models: ['minimax-h3-2k'] },
      { capability: 'video.first-last-frame', models: ['minimax-h3-2k'] },
      { capability: 'music.generate', models: ['minimax-music3'] },
    ])
  })

  it('reports six roles and keeps a choice in the storage domain across a restart', async () => {
    const first = await boot({ answer: async () => json(hilo({ image: [IMAGE, { ...IMAGE, platformModel: 'minimax-h3-image-enhanced' }] })) })
    await vi.waitFor(() => { expect(first.ctx.suanliModels.media().status).toBe('ready') })
    expect(first.ctx.suanliModels.roles().map(state => state.role)).toEqual(['chat', 'vision', 'image', 'video', 'music', 'speech'])
    const changed = vi.fn()
    first.ctx.on('suanli-model-catalog/roles-updated', changed)
    await first.ctx.suanliModels.selectRole('image', 'minimax-h3-image-enhanced')
    await first.ctx.suanliModels.setAutoReview(false)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(first.storage.domains.get('suanli_model_roles:choice')?.get('image')).toEqual({ model: 'minimax-h3-image-enhanced' })
    // The choice lives outside settings.
    expect(first.mutations.every(mutation => JSON.stringify(mutation).includes('"models"'))).toBe(true)
    await expect(first.ctx.suanliModels.selectRole('image', 'not-listed')).rejects.toThrow(/not a image model/u)
    await expect(first.ctx.suanliModels.selectRole('chat', 'deepseek-v4-1-flash')).rejects.toThrow(/takes no choice/u)
    const image = first.ctx.suanliModels.roles().find(state => state.role === 'image')
    expect(image).toMatchObject({ selected: 'minimax-h3-image-enhanced', fallback: 'minimax-h3-image-enhanced' })
    expect(first.ctx.suanliModels.preferences()).toEqual({ autoReview: false })
    expect(first.ctx.suanliModels.roles().find(state => state.role === 'speech')).toMatchObject({ candidates: [], fallback: null })
  })

  it('validates a candidate key without storing it and decodes fixed roles with thinking efforts', async () => {
    const text = TEXT.map((model, index) => ({ ...model, reasoningEffort: index === 0 ? 'off' : 'high' }))
    const { ctx, send, credentialWrites } = await boot({
      answer: async url => url.endsWith('/v1/models') ? json({ data: [] }) : json(hilo({ text })),
    })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    const before = send.mock.calls.length
    const result = await ctx.suanliModels.testLockedConfig({ key: 'sk-candidate' })
    expect(result.ok).toBe(true)
    expect(credentialWrites).toEqual([])
    expect(result.roles?.find(role => role.role === 'chat')?.candidates[0]).toMatchObject({ reasoningEffort: 'off' })
    expect(result.roles?.find(role => role.role === 'vision')?.candidates[1]).toMatchObject({ reasoningEffort: 'high' })
    const validation = send.mock.calls.slice(before).map(([url]) => url)
    expect(validation).toEqual(['https://gw.example/v1/models', 'https://gw.example/api/v1/models/catalog'])
    expect(JSON.stringify(send.mock.calls[before]?.[1]?.headers)).toContain('sk-candidate')
  })

  it('saves only after validation succeeds and reports rejection without a write', async () => {
    let rejected = false
    const { ctx, credentialWrites } = await boot({
      answer: async (url) => {
        if (url.endsWith('/v1/models')) return json({ error: 'bad key' }, rejected ? 401 : 200)
        return json(hilo())
      },
    })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    await expect(ctx.suanliModels.saveLockedConfig({ key: 'sk-next' })).resolves.toMatchObject({ ok: true, saved: true })
    expect(credentialWrites).toEqual(['sk-next'])
    rejected = true
    await expect(ctx.suanliModels.saveLockedConfig({ key: 'sk-bad' })).resolves.toEqual({ ok: false, reason: 'unauthorized' })
    expect(credentialWrites).toEqual(['sk-next'])
    await expect(ctx.suanliModels.testLockedConfig({ key: '' })).resolves.toMatchObject({ ok: false, reason: 'unauthorized' })
  })
})

describe('SuanliModelCatalogService edges', () => {
  /** Boot with neighbours a test shapes itself. */
  async function bootWith(options: {
    readonly resolve?: () => Promise<{ value: string } | undefined>
    readonly open?: () => Promise<never>
    readonly settingsValue?: unknown
    readonly answer?: () => Promise<Response>
    readonly config?: Record<string, unknown>
  }) {
    const ctx = new Context()
    contexts.push(ctx)
    const warnings: string[] = []
    ctx.provide('loader', { await: async () => undefined })
    ctx.provide('credentials', { resolve: options.resolve ?? (async () => ({ value: 'sk-test' })) })
    const mutations: unknown[] = []
    ctx.provide('settings', {
      describe: () => [{ ns: 'llm-custom', value: options.settingsValue }],
      mutate: async (ns: string, ops: unknown) => { mutations.push({ ns, ops }) },
    })
    ctx.provide('typert', {})
    if (options.open !== undefined) ctx.provide('storageDomain', { open: options.open })
    const send = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => await (options.answer ?? (async () => json(hilo())))())
    vi.stubGlobal('fetch', send)
    const updates: unknown[] = []
    ctx.on('llm/models-updated', (provider) => { updates.push(provider) })
    await ctx.plugin(SuanliModelCatalogService, {
      baseURL: 'https://gw.example/v1', apiKeyEnv: 'AURORA_API_KEY',
      settingsNamespace: 'llm-custom', provider: 'custom', catalogPath: '/custom/catalog', timeoutMs: 5_000,
      ...options.config,
    })
    vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
    return { ctx, send, mutations, updates, warnings }
  }

  it('answers from the pending snapshot while the catalog store is still opening', async () => {
    const { ctx, send } = await bootWith({ open: () => new Promise<never>(() => {}) })
    expect(ctx.suanliModels.media()).toMatchObject({ status: 'loading', entries: [] })
    expect(ctx.suanliModels.roles().every(role => role.candidates.length === 0)).toBe(true)
    await expect(ctx.suanliModels.refresh()).resolves.toEqual({ ok: false, reason: 'unreachable', kept: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps the catalog and role choices in memory when the storage domain cannot open', async () => {
    const { ctx, send } = await bootWith({ open: async () => { throw new Error('locked') } })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    expect(send.mock.calls[0]?.[0]).toBe('https://gw.example/custom/catalog')
    await ctx.suanliModels.selectRole('image', null)
    expect(ctx.suanliModels.roles().find(role => role.role === 'image')?.selected).toBeNull()
  })

  it('reports a read that throws through the snapshot instead of the call', async () => {
    let fail = true
    const { ctx, warnings } = await bootWith({ resolve: async () => { if (fail) throw new Error('vault'); return { value: 'sk' } } })
    await vi.waitFor(() => { expect(warnings.some(line => line.includes('media catalog startup failed'))).toBe(true) })
    await expect(ctx.suanliModels.refresh()).resolves.toMatchObject({ ok: false, reason: 'unreachable' })
    expect(warnings.some(line => line.includes('media catalog read failed'))).toBe(true)
    fail = false
    ctx.emit('credentials/reference-updated', credentialRef('AURORA_API_KEY'))
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
  })

  it('reports an empty chat listing when the catalog carries no text section', async () => {
    const { ctx, mutations } = await bootWith({ answer: async () => json(hilo({ text: [] })) })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    await expect(ctx.suanliModels.refresh()).resolves.toEqual({ ok: false, reason: 'empty-listing', kept: 0 })
    expect(mutations).toEqual([])
  })

  it('reports an empty or signed-out catalog as readable', async () => {
    const empty = await bootWith({ answer: async () => json(hilo({ image: [], video: [], audio: [] })) })
    await vi.waitFor(() => { expect(empty.ctx.suanliModels.media().status).toBe('empty') })
    await expect(empty.ctx.suanliModels.refresh()).resolves.toMatchObject({ ok: true, capabilities: true })
    let listed = true
    const none = await bootWith({ answer: async () => json(listed ? hilo({}) : hilo({ text: [], image: [], video: [], audio: [] })) })
    await vi.waitFor(() => { expect(none.ctx.suanliModels.media().status).toBe('ready') })
    await expect(none.ctx.suanliModels.refresh()).resolves.toMatchObject({ ok: true })
    listed = false
    await expect(none.ctx.suanliModels.refresh()).resolves.toMatchObject({ ok: false, reason: 'empty-listing' })
    const signedOut = await bootWith({ resolve: async () => undefined })
    await vi.waitFor(() => { expect(signedOut.ctx.suanliModels.media().status).toBe('signed-out') })
    await expect(signedOut.ctx.suanliModels.refresh()).resolves.toMatchObject({ ok: true, capabilities: true })
  })

  it('reads the route catalog past malformed settings and writes to its own entry', async () => {
    const malformed = await bootWith({ settingsValue: 'broken' })
    expect(malformed.ctx.suanliModels.read()).toEqual([])
    const noList = await bootWith({ settingsValue: { models: 'none' } })
    expect(noList.ctx.suanliModels.read()).toEqual([])
    const { ctx, mutations, updates } = await bootWith({
      settingsValue: { models: [null, { id: '' }, { id: 'kept', contextWindow: 8, inputModalities: ['text'] }] },
      answer: async () => json(hilo({ text: [{ id: 'listen', platformModel: 'listen', supportsAudio: true }] })),
    })
    expect(ctx.suanliModels.read()).toEqual([{ id: 'kept', contextWindow: 8, inputModalities: ['text'] }])
    await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]).toEqual({ ns: 'llm-custom', ops: [{ op: 'set', path: ['models'], value: [{ id: 'listen', inputModalities: ['text'] }] }] })
    expect(updates).toEqual(['custom'])
    expect(ctx.suanliModels.capabilities().filter(entry => entry.capability.startsWith('vision'))).toEqual([])
  })

  it('logs what the catalog dropped', async () => {
    const { ctx, warnings } = await bootWith({ answer: async () => json(hilo({ image: [IMAGE, { id: 'no-model' }] })) })
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    expect(warnings.some(line => line.includes('dropped 1 entry'))).toBe(true)
  })
})
