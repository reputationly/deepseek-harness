/** Media catalog: the last good generation stays in effect, and each read reports why it produced nothing. */
import { describe, expect, it, vi } from 'vitest'
import { classMembers } from '../src/capabilities.ts'
import { asGatewayCapability, decodeCatalog, mediaEntries } from '../src/media.ts'
import { MediaCatalogSync, type MediaCatalogRecord } from '../src/media-sync.ts'

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

/** The gateway's answer as one media catalog. */
function catalog(capabilities: readonly unknown[], version = 'v1'): Response {
  return json(payloadOf(capabilities, version))
}

/** Decoded entries of one fixture catalog, for a store that holds them. */
function entriesOf(capabilities: readonly unknown[]): MediaCatalogRecord['entries'] {
  const decoded = decodeCatalog(payloadOf(capabilities))
  if (decoded === undefined) throw new Error('fixture catalog does not decode')
  return decoded.entries
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function harness(options: {
  readonly answer?: () => Promise<Response>
  readonly key?: string
  readonly stored?: MediaCatalogRecord
  readonly now?: () => number
}) {
  const written: MediaCatalogRecord[] = []
  const changes: string[] = []
  const reports: string[] = []
  const send = vi.fn(async () => await (options.answer ?? (async () => catalog([entry()])))())
  const subject = new MediaCatalogSync({
    origin: 'https://gateway.example',
    capabilitiesPath: '/v1/ov/capabilities',
    timeoutMs: 1_000,
    send,
    credential: async () => (options.key === undefined ? 'sk-test' : options.key),
    store: { read: () => options.stored, write: async (record) => { written.push(record) } },
    now: options.now ?? (() => 1_700_000_000_000),
    report: (message) => { reports.push(message) },
    changed: () => { changes.push('changed') },
  })
  return { subject, written, changes, reports, send }
}

describe('MediaCatalogSync', () => {
  it('commits a readable catalog and keeps every entry it carries', async () => {
    const { subject, written, changes } = harness({
      answer: async () => catalog([
        entry(),
        entry({ id: 'generate_image:minimax-h3-2k', model: 'minimax-h3-2k', default: false }),
        entry({ id: 'generate_video:minimax-h3-ref-2k', operation: 'generate_video', model: 'minimax-h3-ref-2k', transport: { kind: 'videos_task' } }),
        entry({ id: 'upscale:relayvsr', operation: 'upscale', model: 'relayvsr' }),
        entry({ id: 'chat:deepseek-v4-1-flash', operation: 'chat', model: 'deepseek-v4-1-flash', transport: { kind: 'chat' } }),
      ]),
    })
    const snapshot = await subject.refresh()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.version).toBe('v1')
    expect(snapshot.fetchedAt).toBe(1_700_000_000_000)
    expect(snapshot.entries.map(candidate => candidate.id)).toEqual([
      'generate_image:minimax-h3-image-enhanced',
      'generate_image:minimax-h3-2k',
      'generate_video:minimax-h3-ref-2k',
      'upscale:relayvsr',
      'chat:deepseek-v4-1-flash',
    ])
    // Every operation is kept; only the workbench filters what it renders.
    expect(written).toHaveLength(1)
    expect(changes).toEqual(['changed'])
  })

  it.each([
    ['signed-out', { key: '' }],
    ['unauthorized', { answer: async () => json({}, 401) }],
    ['kyc-required', { answer: async () => json({ error: { code: 'kyc_required' } }, 403) }],
    ['unauthorized', { answer: async () => json({ error: { code: 'forbidden' } }, 403) }],
    ['unauthorized', { answer: async () => new Response('no body', { status: 403 }) }],
    ['rate-limited', { answer: async () => json({}, 429) }],
    ['unreachable', { answer: async () => json({}, 500) }],
    ['unreachable', { answer: async () => { throw new Error('connect ECONNREFUSED') } }],
    ['unreachable', { answer: async () => new Response('not json', { status: 200 }) }],
    ['unreachable', { answer: async () => json({ nope: true }) }],
  ] as const)('reports %s and keeps the previous generation', async (status, options) => {
    const stored: MediaCatalogRecord = { version: 'kept', fetchedAt: 1, entries: entriesOf([entry()]) }
    const { subject, written } = harness({ ...options, stored })
    subject.hydrate()
    await expect(subject.refresh()).resolves.toMatchObject({ status, version: 'kept', fetchedAt: 1 })
    expect(written).toEqual([])
    expect(subject.current().entries).toHaveLength(1)
  })

  it('reports an empty catalog without discarding the entries in effect', async () => {
    const stored: MediaCatalogRecord = { version: 'kept', fetchedAt: 1, entries: entriesOf([entry()]) }
    const { subject, written } = harness({
      stored,
      answer: async () => catalog([entry({ id: 'chat:model', operation: 'chat', model: 'model', transport: { kind: 'chat' } })], 'v2'),
    })
    subject.hydrate()
    await expect(subject.refresh()).resolves.toMatchObject({ status: 'empty', version: 'kept' })
    expect(written).toEqual([])
  })

  it('joins concurrent refreshes into one request', async () => {
    const { subject, send } = harness({})
    await Promise.all([subject.refresh(), subject.refresh(), subject.refresh()])
    expect(send).toHaveBeenCalledOnce()
  })

  it('stores the generation only when the version changes', async () => {
    const unchanged = harness({ answer: async () => catalog([entry()], 'v1') })
    await unchanged.subject.refresh()
    await unchanged.subject.refresh()
    expect(unchanged.written).toHaveLength(1)

    const changed = harness({ answer: async () => catalog([entry()], 'v2') })
    await changed.subject.refresh()
    await changed.subject.refresh()
    // The second read repeats v2, so only the first one stores.
    expect(changed.written).toHaveLength(1)
  })

  it('seeds the snapshot from the stored generation before the first read', () => {
    const stored: MediaCatalogRecord = { version: 'stored', fetchedAt: 7, entries: entriesOf([entry()]) }
    const { subject } = harness({ stored })
    expect(subject.current()).toMatchObject({ status: 'loading', version: null, entries: [] })
    subject.hydrate()
    expect(subject.current()).toMatchObject({ status: 'loading', version: 'stored', fetchedAt: 7 })
    expect(subject.current().entries).toHaveLength(1)
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
