/**
 * Host Remote namespace that refreshes the product's model catalog from its gateway.
 *
 * The route's `models` field is volatile configuration, so the catalog this service writes
 * takes effect for the running route without a restart: the gateway's listing becomes what
 * the model picker offers. A refresh never clears the catalog — a failed or empty listing
 * keeps the entries already in effect and reports why.
 *
 * The same service owns the gateway's capability catalog, which the media workbench renders: it is read
 * on startup, on a credential change, and on request, its last good generation survives a restart, and
 * `media()` reports why a read produced nothing. Consumers that call the gateway themselves read
 * `endpoint()` rather than configuring the gateway a second time.
 *
 * @module @deepseek-ai/dsh-suanli-model-catalog
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { classMembers } from './capabilities.ts'
import { domainCatalogStore, mediaCatalogDomain, memoryCatalogStore } from './domain.ts'
import { asGatewayCapability } from './media.ts'
import { MediaCatalogSync, type MediaCatalogStore } from './media-sync.ts'
import type {
  CatalogEntry, CatalogSyncResult, ClassMembers, MediaCatalogSnapshot, MediaGatewayEndpoint,
} from './types.ts'
import { CatalogSync } from './sync.ts'
import {
  DEFAULT_CATALOG_CAPABILITIES_PATH, DEFAULT_CATALOG_MODELS_PATH, DEFAULT_CATALOG_TIMEOUT_MS,
} from './defaults.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `suanliModels` Remote namespace. */
    suanliModels: SuanliModelCatalogService
  }
}

/** Catalog source policy: which gateway answers, which key authorizes it, and who receives the result. */
export interface Config {
  /** Gateway origin or root that already carries its API prefix. */
  readonly baseURL: string
  /** Credential reference holding the gateway key. */
  readonly apiKeyEnv: string
  /** Listing path on the gateway (default `/v1/models`). */
  readonly modelsPath?: string
  /** Settings entry whose `models` field receives the catalog (default `llm-deepseek`). */
  readonly settingsNamespace?: string
  /** Provider id whose catalog-changed event the browser follows (default `deepseek-official`). */
  readonly provider?: string
  /** Path of the gateway capability catalog (default `/v1/ov/capabilities`). */
  readonly capabilitiesPath?: string
  /** Request budget of one listing, in milliseconds. */
  readonly timeoutMs?: number
  /**
   * Endpoint types a listed row must declare to join the catalog (default `openai`, the chat
   * endpoint). Image, video, and music endpoints stay out until the picker can drive them.
   */
  readonly endpointTypes: string[]
}

/** Host service backing the generated `ctx.remote.suanliModels` namespace. */
export class SuanliModelCatalogService extends TypertRemoteService {
  static inject = ['credentials', 'settings', 'typert']

  static Config: z<Config> = z.object({
    baseURL: z.string().min(1),
    apiKeyEnv: z.string().role('credential-ref').min(1),
    modelsPath: z.string().pattern(/^\//u).default(DEFAULT_CATALOG_MODELS_PATH),
    capabilitiesPath: z.string().pattern(/^\//u).default(DEFAULT_CATALOG_CAPABILITIES_PATH),
    settingsNamespace: z.string().min(1).default('llm-deepseek'),
    provider: z.string().min(1).default('deepseek-official'),
    timeoutMs: z.natural().min(1).default(DEFAULT_CATALOG_TIMEOUT_MS),
    endpointTypes: z.array(z.string().min(1)).default(['openai']),
  })

  private readonly ref: CredentialRef
  private readonly namespace: string
  private readonly provider: string
  private readonly origin: string
  private readonly capabilitiesPath: string
  private readonly timeoutMs: number
  private readonly endpointFacts: MediaGatewayEndpoint
  private readonly sync: CatalogSync
  private readonly send: typeof fetch = (input, init) => fetch(input, init)
  /** Snapshot served before the durable store is open and the first read has settled. */
  private readonly pending: MediaCatalogSnapshot = { status: 'loading', version: null, fetchedAt: null, entries: [] }
  private mediaSync: MediaCatalogSync | undefined
  private cache: { close(): Promise<void> } | undefined

  /**
   * @param ctx - Host context carrying the credential provider, settings, and Typert registry.
   * @param config - gateway endpoint, credential reference, and receiving settings entry.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'suanliModels', { namespace: 'suanliModels' })
    this.ref = credentialRef(config.apiKeyEnv)
    this.namespace = config.settingsNamespace ?? 'llm-deepseek'
    this.provider = config.provider ?? 'deepseek-official'
    this.origin = new URL(config.baseURL).origin
    this.capabilitiesPath = config.capabilitiesPath ?? DEFAULT_CATALOG_CAPABILITIES_PATH
    this.timeoutMs = config.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS
    this.endpointFacts = { baseURL: config.baseURL, credential: config.apiKeyEnv }
    this.sync = new CatalogSync({
      origin: this.origin,
      modelsPath: config.modelsPath ?? DEFAULT_CATALOG_MODELS_PATH,
      timeoutMs: this.timeoutMs,
      endpointTypes: config.endpointTypes,
      send: this.send,
      credential: async () => {
        const stored = await this.ctx.credentials.resolve(this.ref)
        return stored?.value
      },
      current: () => this.current(),
      write: async (models) => {
        await this.ctx.settings.mutate(this.namespace, [{ op: 'set', path: ['models'], value: [...models] }])
        this.ctx.emit('llm/models-updated', this.provider)
      },
    })
    ctx.effect(() => () => { void this.cache?.close() })
    ctx.on('credentials/reference-updated', (ref) => {
      if (ref !== this.ref) return
      void this.refreshMedia().then(() => undefined, (error: unknown) => {
        ctx.logger.warn('suanli model catalog: refresh after a credential change failed: %s', String(error))
      })
    })
    // Boot does not wait for the gateway: the durable generation serves the first render.
    void this.startMedia().catch((error: unknown) => {
      ctx.logger.warn('suanli model catalog: media catalog startup failed: %s', String(error))
    })
  }

  /**
   * Refresh the catalog from the gateway and put it in effect.
   * @returns how the catalog changed, or why it stayed as it was.
   */
  @Remote
  async refresh(): Promise<CatalogSyncResult> {
    const [models, media] = await Promise.all([this.sync.refresh(), this.refreshMedia()])
    if (!models.ok) return models
    return {
      ...models,
      classes: classMembers(media.entries.map(asGatewayCapability)),
      capabilities: media.status === 'ready' || media.status === 'empty',
    }
  }

  /**
   * Read the entries the route offers now, without contacting the gateway.
   * @returns the catalog in effect.
   */
  @Remote
  read(): readonly CatalogEntry[] {
    return this.current()
  }

  /**
   * Read the capability classes the gateway declared at the last successful read.
   * @returns one member list per class, empty before a read succeeds.
   */
  @Remote
  capabilities(): readonly ClassMembers[] {
    return classMembers(this.media().entries.map(asGatewayCapability))
  }

  /**
   * Read the media catalog and why it is in the state it reports.
   * @returns the status, version, fetch time, and every entry of the last successful read.
   */
  @Remote
  media(): MediaCatalogSnapshot {
    return this.mediaSync?.current() ?? this.pending
  }

  /**
   * Read the gateway a consumer must call to reach the catalog's capabilities.
   * @returns the gateway root and the credential reference holding its key.
   */
  @Remote
  endpoint(): MediaGatewayEndpoint {
    return this.endpointFacts
  }

  /** Open the durable generation store, seed the catalog from it, and read the gateway once. */
  private async startMedia(): Promise<void> {
    const mediaSync = new MediaCatalogSync({
      origin: this.origin,
      capabilitiesPath: this.capabilitiesPath,
      timeoutMs: this.timeoutMs,
      send: this.send,
      credential: async () => (await this.ctx.credentials.resolve(this.ref))?.value,
      store: await this.openStore(),
      now: () => Date.now(),
      report: (message) => { this.ctx.logger.warn(message) },
      changed: () => { this.ctx.emit('suanli-model-catalog/media-updated') },
    })
    mediaSync.hydrate()
    this.mediaSync = mediaSync
    await mediaSync.refresh()
  }

  /**
   * Open the cache domain, or degrade to process memory.
   * @returns the store the media catalog keeps its last good generation in.
   */
  private async openStore(): Promise<MediaCatalogStore> {
    const facility = this.ctx.get('storageDomain')
    if (facility === undefined) return memoryCatalogStore()
    try {
      const domain = await facility.open(mediaCatalogDomain)
      this.cache = domain
      return domainCatalogStore(domain.table('snapshot'))
    } catch (error) {
      this.ctx.logger.warn('suanli model catalog: media catalog cache is unavailable (%s); keeping the catalog in memory', String(error))
      return memoryCatalogStore()
    }
  }

  /** Refresh the media catalog, reporting a rejected read through the snapshot instead of the call. */
  private async refreshMedia(): Promise<MediaCatalogSnapshot> {
    if (this.mediaSync === undefined) return this.pending
    try {
      return await this.mediaSync.refresh()
    } catch (error) {
      this.ctx.logger.warn('suanli model catalog: media catalog read failed: %s', String(error))
      return this.mediaSync.current()
    }
  }

  /** Entries the receiving settings entry currently holds. */
  private current(): readonly CatalogEntry[] {
    const entry = this.ctx.settings.describe().find(candidate => candidate.ns === this.namespace)
    const value: unknown = entry?.value
    if (typeof value !== 'object' || value === null) return []
    const models = (value as { models?: unknown }).models
    if (!Array.isArray(models)) return []
    return (models as readonly unknown[]).flatMap((model) => {
      if (typeof model !== 'object' || model === null) return []
      const { id, contextWindow, inputModalities } = model as { id?: unknown; contextWindow?: unknown; inputModalities?: unknown }
      if (typeof id !== 'string' || id === '') return []
      return [{
        id,
        ...typeof contextWindow === 'number' ? { contextWindow } : {},
        ...Array.isArray(inputModalities)
          ? { inputModalities: inputModalities.filter((kind: unknown): kind is string => typeof kind === 'string') }
          : {},
      }]
    })
  }
}

export default SuanliModelCatalogService
