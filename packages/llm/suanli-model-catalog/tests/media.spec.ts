/** Media catalog: the last good Hilo generation stays in effect, and each read reports why it produced nothing. */
import { describe, expect, it, vi } from 'vitest'
import { classMembers } from '../src/capabilities.ts'
import { asGatewayCapability, decodeCatalog, mediaEntries } from '../src/media.ts'
import { MediaCatalogSync, type MediaCatalogRecord } from '../src/media-sync.ts'
import { hilo, IMAGE, json } from './hilo-fixture.ts'

/** One capability entry as the gateway reports it. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'generate_image:minimax-h3-image-enhanced',
    operation: 'generate_image',
    model: 'minimax-h3-image-enhanced',
    displayName: { zh: '增强', en: 'Enhanced' },
    description: { zh: '', en: '' },
    transport: { kind: 'images' },
    limits: { maxReferenceImages: 2, maxDurationSeconds: 0, maxInputBytes: 1024 },
    default: true,
    ...overrides,
  }
}

/** A gateway payload carrying these capabilities. */
function payloadOf(capabilities: readonly unknown[], version = 'v1'): unknown {
  return { version, capabilities }
}

/** Decoded entries of one fixture catalog, for a store that holds them. */
function entriesOf(capabilities: readonly unknown[]): MediaCatalogRecord['entries'] {
  const decoded = decodeCatalog(payloadOf(capabilities))
  if (decoded === undefined) throw new Error('fixture catalog does not decode')
  return decoded.entries
}

const EMPTY_CHAT = { text: [], defaults: { chat: null, multimodal: null } } as const

function harness(options: {
  readonly answer?: () => Promise<Response>
  readonly key?: string
  readonly stored?: MediaCatalogRecord
  readonly now?: () => number
}) {
  const written: MediaCatalogRecord[] = []
  const committed: MediaCatalogRecord[] = []
  const changes: string[] = []
  const reports: string[] = []
  const send = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => await (options.answer ?? (async () => json(hilo())))())
  const subject = new MediaCatalogSync({
    origin: 'https://gateway.example',
    catalogPath: '/api/v1/models/catalog',
    timeoutMs: 1_000,
    send,
    credential: async () => (options.key === undefined ? 'sk-test' : options.key),
    store: { read: () => options.stored, write: async (record) => { written.push(record) } },
    now: options.now ?? (() => 1_700_000_000_000),
    report: (message) => { reports.push(message) },
    changed: () => { changes.push('changed') },
    committed: async (record) => { committed.push(record) },
  })
  return { subject, written, committed, changes, reports, send }
}

describe('MediaCatalogSync', () => {
  it('reads the Hilo catalog anonymously and commits every generation entry it carries', async () => {
    const { subject, written, committed, changes, send } = harness({})
    const snapshot = await subject.refresh()
    expect(send).toHaveBeenCalledOnce()
    const [url, init] = send.mock.calls[0] ?? []
    expect(url).toBe('https://gateway.example/api/v1/models/catalog')
    // The catalog is anonymous: the gateway key never leaves with this read.
    expect(init?.headers).toEqual({ accept: 'application/json' })
    expect(snapshot.status).toBe('ready')
    expect(snapshot.version).toBe('v1')
    expect(snapshot.fetchedAt).toBe(1_700_000_000_000)
    expect(snapshot.entries.map(candidate => candidate.id)).toEqual([
      'generate_image:minimax-h3-image', 'generate_video:minimax-h3-2k', 'generate_music:minimax-music3',
    ])
    expect(subject.roles().text.map(model => model.model)).toEqual(['deepseek-v4-1-flash', 'qwen3.8-flash-fp8'])
    expect(written).toHaveLength(1)
    expect(committed).toHaveLength(1)
    expect(changes).toEqual(['changed'])
  })

  it('still reads the catalog without a key and reports signed-out', async () => {
    const { subject, send } = harness({ key: '' })
    await expect(subject.refresh()).resolves.toMatchObject({ status: 'signed-out', version: 'v1' })
    expect(send).toHaveBeenCalledOnce()
    expect(subject.current().entries).toHaveLength(3)
  })

  it.each([
    ['rate-limited', { answer: async () => json({}, 429) }],
    ['unreachable', { answer: async () => json({}, 401) }],
    ['unreachable', { answer: async () => json({}, 500) }],
    ['unreachable', { answer: async () => { throw new Error('connect ECONNREFUSED') } }],
    ['unreachable', { answer: async () => new Response('not json', { status: 200 }) }],
    ['unreachable', { answer: async () => json({ nope: true }) }],
  ] as const)('reports %s and keeps the previous generation', async (status, options) => {
    const stored: MediaCatalogRecord = { version: 'kept', fetchedAt: 1, entries: entriesOf([entry()]), ...EMPTY_CHAT }
    const { subject, written, committed } = harness({ ...options, stored })
    subject.hydrate()
    await expect(subject.refresh()).resolves.toMatchObject({ status, version: 'kept', fetchedAt: 1 })
    expect(written).toEqual([])
    expect(committed).toEqual([])
    expect(subject.current().entries).toHaveLength(1)
  })

  it('reports an empty catalog without discarding the entries in effect', async () => {
    const stored: MediaCatalogRecord = { version: 'kept', fetchedAt: 1, entries: entriesOf([entry()]), ...EMPTY_CHAT }
    const { subject, written } = harness({ stored, answer: async () => json(hilo({ version: 'v2', image: [], video: [], audio: [], text: [] })) })
    subject.hydrate()
    await expect(subject.refresh()).resolves.toMatchObject({ status: 'empty', version: 'kept' })
    expect(written).toEqual([])
  })

  it('keeps an explicitly committed generation when an older refresh finishes later', async () => {
    let finish: (response: Response) => void = () => {}
    const { subject, committed } = harness({ answer: () => new Promise<Response>((resolve) => { finish = resolve }) })
    const refreshing = subject.refresh()
    await vi.waitFor(() => { expect(finish).not.toBeUndefined() })
    const validated: MediaCatalogRecord = { version: 'validated', fetchedAt: 2, entries: entriesOf([entry()]), ...EMPTY_CHAT }
    await subject.commit(validated)
    finish(json(hilo({ version: 'stale' })))
    await refreshing
    expect(subject.current().version).toBe('validated')
    expect(subject.current().entries).toHaveLength(1)
    expect(committed.map(record => record.version)).toEqual(['validated'])
  })

  it('joins concurrent refreshes into one request', async () => {
    const { subject, send } = harness({})
    await Promise.all([subject.refresh(), subject.refresh(), subject.refresh()])
    expect(send).toHaveBeenCalledOnce()
  })

  it('stores the generation and reports a change only when the version changes', async () => {
    const unchanged = harness({})
    await unchanged.subject.refresh()
    await unchanged.subject.refresh()
    expect(unchanged.written).toHaveLength(1)
    expect(unchanged.changes).toEqual(['changed'])

    let version = 'v1'
    const changed = harness({ answer: async () => json(hilo({ version })) })
    await changed.subject.refresh()
    version = 'v2'
    await changed.subject.refresh()
    expect(changed.written.map(record => record.version)).toEqual(['v1', 'v2'])
    expect(changed.changes).toEqual(['changed', 'changed'])
  })

  it('warns about an unknown interface type once per version', async () => {
    const { subject, reports } = harness({ answer: async () => json(hilo({ image: [{ ...IMAGE, interfaceType: 'maas-image-v9' }] })) })
    await subject.refresh()
    await subject.refresh()
    expect(reports.filter(message => message.includes('maas-image-v9'))).toHaveLength(1)
  })

  it('seeds the snapshot and chat models from the stored generation before the first read', () => {
    const stored: MediaCatalogRecord = {
      version: 'stored', fetchedAt: 7, entries: entriesOf([entry()]),
      text: [{ model: 'm', label: 'M', supportsImage: false, supportsVideo: false, supportsAudio: false }],
      defaults: { chat: 'm', multimodal: null },
    }
    const { subject } = harness({ stored })
    expect(subject.current()).toMatchObject({ status: 'loading', version: null, entries: [] })
    subject.hydrate()
    expect(subject.current()).toMatchObject({ status: 'loading', version: 'stored', fetchedAt: 7 })
    expect(subject.current().entries).toHaveLength(1)
    expect(subject.roles().defaults.chat).toBe('m')
  })
})

describe('decodeCatalog', () => {
  it('reads the modes, parameters, and limits the workbench renders', () => {
    const decoded = decodeCatalog({
      version: 'hash',
      capabilities: [entry({
        taskTypes: ['t2i', 'i2i'],
        deliveryDurations: [1.625, 5.125],
        paramSchema: { type: 'object', properties: {
          resolution: { type: 'string', title: '分辨率', enum: ['1K', '2K'], default: '2K' },
          duration: { type: 'string', minimum: 1, maximum: 10 },
        } },
        modes: [{
          id: 'reference',
          label: { zh: '参考生视频', en: 'Reference to video' },
          taskType: 'r2va',
          references: { image: { min: 0, max: 9 }, video: { min: 0, max: 3 }, audio: { min: 0, max: 3 } },
          requiresSourceVideo: false,
          note: { zh: '至少给一项', en: 'At least one' },
        }],
      })],
    })
    expect(decoded?.version).toBe('hash')
    expect(decoded?.entries[0]).toMatchObject({
      taskTypes: ['t2i', 'i2i'],
      deliveryDurations: [1.625, 5.125],
      paramSchema: { type: 'object', properties: {
        resolution: { type: 'string', title: '分辨率', enum: ['1K', '2K'], default: '2K' },
        duration: { type: 'string', minimum: 1, maximum: 10 },
      } },
      modes: [{ id: 'reference', taskType: 'r2va', references: { image: { min: 0, max: 9 }, video: { min: 0, max: 3 }, audio: { min: 0, max: 3 } }, note: { zh: '至少给一项', en: 'At least one' } }],
      limits: { maxReferenceImages: 2, maxDurationSeconds: 0, maxInputBytes: 1024 },
    })
  })

  it('drops an entry without its required fields and reports how many', () => {
    const decoded = decodeCatalog({
      capabilities: [
        entry(),
        entry({ id: '' }),
        entry({ operation: undefined }),
        entry({ model: undefined }),
        entry({ transport: undefined }),
        entry({ transport: { kind: '' } }),
      ],
    })
    expect(decoded?.entries).toHaveLength(1)
    expect(decoded?.dropped).toBe(5)
  })

  it('reports no catalog when the payload carries no capability list', () => {
    expect(decodeCatalog({})).toBeUndefined()
    expect(decodeCatalog(null)).toBeUndefined()
    expect(decodeCatalog({ capabilities: 'none' })).toBeUndefined()
  })

  it('treats a missing version as always changed', () => {
    expect(decodeCatalog({ capabilities: [entry()] })?.version).toBeNull()
  })
})

describe('mediaEntries', () => {
  it('renders the image and video entries and leaves the other operations to their own consumers', () => {
    const decoded = decodeCatalog(payloadOf([
      entry({ taskTypes: ['t2i'] }),
      entry({ id: 'generate_video:h3', operation: 'generate_video', model: 'h3', transport: { kind: 'videos_task' }, taskTypes: ['r2va'] }),
      entry({ id: 'upscale:relayvsr', operation: 'upscale', model: 'relayvsr' }),
      entry({ id: 'chat:m', operation: 'chat', model: 'm', transport: { kind: 'chat' } }),
    ]))
    const rendered = mediaEntries(decoded!.entries)
    expect(rendered.map(candidate => candidate.model)).toEqual(['minimax-h3-image-enhanced', 'h3'])
    // Capability classes come from the same entries, so the picker and the workbench cannot disagree.
    expect(classMembers(decoded!.entries.map(asGatewayCapability))).toEqual([
      { capability: 'chat', models: ['m'] },
      { capability: 'image.generate', models: ['minimax-h3-image-enhanced'] },
      { capability: 'video.reference', models: ['h3'] },
      { capability: 'other', models: ['relayvsr'] },
    ])
  })
})

describe('MediaCatalogSync edges', () => {
  it('reports a body it cannot parse or decode as unreachable', async () => {
    const broken = harness({ answer: async () => new Response('not json', { status: 200 }) })
    await expect(broken.subject.refresh()).resolves.toMatchObject({ status: 'unreachable' })
    const foreign = harness({ answer: async () => json({ capabilities: [] }) })
    await expect(foreign.subject.refresh()).resolves.toMatchObject({ status: 'unreachable' })
  })

  it('counts several dropped rows and keeps the read when the store refuses it', async () => {
    const { subject, reports } = harness({ answer: async () => json(hilo({ image: [IMAGE, { id: 'a' }, { id: 'b' }] })) })
    ;(subject as unknown as { inputs: { store: { write: () => Promise<void> } } }).inputs.store.write = async () => { throw new Error('disk full') }
    await expect(subject.refresh()).resolves.toMatchObject({ status: 'ready' })
    expect(reports.some(message => message.includes('dropped 2 entries'))).toBe(true)
    expect(reports.some(message => message.includes('disk full'))).toBe(true)
  })

  it('does not announce a stored generation over entries already in effect', async () => {
    const stored: MediaCatalogRecord = { version: 'stored', fetchedAt: 7, entries: entriesOf([entry()]), ...EMPTY_CHAT }
    const { subject, changes } = harness({ stored })
    subject.hydrate()
    subject.hydrate()
    expect(changes).toHaveLength(1)
  })
})

describe('decodeCatalog edges', () => {
  it('fills defaults for malformed stored fields and drops unusable modes', () => {
    const decoded = decodeCatalog({ capabilities: [entry({
      displayName: { zh: 1, en: null },
      limits: { maxReferenceImages: 'two' },
      paramSchema: { type: 3, properties: { loose: 'x', typed: { type: 5, enum: [] } } },
      modes: [{ id: '' }, { id: 'ok', taskType: 7 }],
    })] })
    expect(decoded?.entries[0]).toMatchObject({
      displayName: { zh: '', en: '' },
      limits: { maxReferenceImages: 0 },
      paramSchema: { type: 'object', properties: { loose: { type: 'string' }, typed: { type: 'string' } } },
      modes: [{ id: 'ok', taskType: '' }],
    })
  })
})

describe('MediaCatalogSync repeated failures', () => {
  it('announces a failure once while the gateway stays down', async () => {
    const { subject, changes } = harness({ answer: async () => new Response('', { status: 502 }) })
    await subject.refresh()
    await subject.refresh()
    expect(changes).toHaveLength(1)
  })
})
