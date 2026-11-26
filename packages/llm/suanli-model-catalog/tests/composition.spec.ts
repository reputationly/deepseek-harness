/**
 * The catalog service against a real HTTP gateway.
 *
 * The unit specs stub `fetch`, so they cannot catch a wrong path join, a missing `/v1`, or a
 * header the gateway needs. This one runs a canned gateway on a loopback port and drives the real
 * service through it: the startup read, the classes derived from the same entries, and a restart
 * that serves the stored generation while the gateway is unreachable.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SuanliModelCatalogService from '../src/index.ts'
import type { StoredSnapshot } from '../src/domain.ts'

/** One canned gateway on a loopback port. */
interface FakeGateway {
  /** Root URL, without the `/v1` the service joins on the origin. */
  readonly origin: string
  /** Stop the server. */
  close(): Promise<void>
}

/** The capability catalog this gateway publishes. */
const CATALOG = {
  version: 'fake',
  capabilities: [
    { id: 'generate_image:fake-image', operation: 'generate_image', model: 'fake-image', displayName: { zh: '假图', en: 'Fake image' }, transport: { kind: 'images' }, taskTypes: ['t2i'], limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 }, default: true },
    { id: 'generate_video:fake-video', operation: 'generate_video', model: 'fake-video', displayName: { zh: '假片', en: 'Fake video' }, transport: { kind: 'videos_task' }, taskTypes: ['t2v'], limits: { maxReferenceImages: 0, maxDurationSeconds: 15, maxInputBytes: 0 }, default: true },
  ],
}

/**
 * Start a canned gateway.
 * @returns the running gateway.
 */
async function startFakeGateway(): Promise<FakeGateway> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/v1/ov/capabilities') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(CATALOG))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: `no canned response for ${String(path)}` } }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
  }
}

const contexts: Context[] = []
const gateways: FakeGateway[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const gateway of gateways.splice(0)) await gateway.close()
})

/** One durable generation store shared by successive boots. */
function store(records = new Map<string, StoredSnapshot>()) {
  return {
    records,
    service: {
      open: async () => ({
        table: () => ({
          get: (key: string) => records.get(key),
          put: async (key: string, value: StoredSnapshot) => { records.set(key, value) },
        }),
        close: async () => {},
      }),
    },
  }
}

/**
 * Mount the real service against a stub neighbourhood.
 * @param baseURL - gateway root the service reads.
 * @param storage - durable store shared across boots.
 * @returns the mounted context.
 */
async function boot(baseURL: string, storage: ReturnType<typeof store>): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('loader', { await: async () => undefined })
  ctx.provide('credentials', { resolve: async () => ({ value: 'sk-test' }) })
  ctx.provide('settings', { describe: () => [], mutate: async () => {} })
  ctx.provide('typert', {})
  ctx.provide('storageDomain', storage.service)
  await ctx.plugin(SuanliModelCatalogService, { baseURL, apiKeyEnv: 'AURORA_API_KEY', endpointTypes: ['openai'] })
  return ctx
}

describe('catalog service over HTTP', () => {
  it('reads the canned catalog at startup and reports the entries and classes it carries', async () => {
    const gateway = await startFakeGateway()
    gateways.push(gateway)
    const ctx = await boot(`${gateway.origin}/v1`, store())
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    const media = ctx.suanliModels.media()
    expect(media.version).toBe('fake')
    const models = media.entries.map(entry => entry.model)
    expect(models).toContain('fake-image')
    expect(models).toContain('fake-video')
    // The classes come from the same entries, so the picker and the workbench cannot disagree.
    const classes = ctx.suanliModels.capabilities().map(members => members.capability)
    expect(classes).toContain('image.generate')
    expect(classes).toContain('video.generate')
  })

  it('serves the stored generation while the gateway is unreachable', async () => {
    const first = await startFakeGateway()
    gateways.push(first)
    const storage = store()
    const online = await boot(`${first.origin}/v1`, storage)
    await vi.waitFor(() => { expect(online.suanliModels.media().status).toBe('ready') })
    expect(storage.records.size).toBe(1)
    await online.fiber.dispose()
    await first.close()
    gateways.splice(gateways.indexOf(first), 1)

    // Same store, gateway gone: the first render still has a catalog, and the status says why.
    const offline = await boot('http://127.0.0.1:1/v1', storage)
    await vi.waitFor(() => { expect(offline.suanliModels.media().status).toBe('unreachable') })
    const media = offline.suanliModels.media()
    expect(media.entries.map(entry => entry.model)).toContain('fake-image')
    expect(media.version).toBe('fake')
  })

  it('accepts a gateway root with or without the /v1 suffix', async () => {
    const gateway = await startFakeGateway()
    gateways.push(gateway)
    // `startFakeGateway` reports a root that already carries `/v1`; the service joins its own path
    // on the origin, so both spellings must reach the same endpoint.
    const ctx = await boot(gateway.origin, store())
    await vi.waitFor(() => { expect(ctx.suanliModels.media().status).toBe('ready') })
    expect(ctx.suanliModels.media().entries.length).toBeGreaterThan(0)
  })
})
