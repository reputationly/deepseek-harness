/**
 * Host Remote namespace that refreshes the product's model catalog from its gateway.
 *
 * The route's `models` field is volatile configuration, so the catalog this service writes
 * takes effect for the running route without a restart: the gateway's listing becomes what
 * the model picker offers. A refresh never clears the catalog — a failed or empty listing
 * keeps the entries already in effect and reports why.
 *
 * Both come from one source, the gateway's Hilo model catalog (`GET /api/v1/models/catalog`, read
 * anonymously): its text section becomes the chat catalog, its image, video, and audio sections become
 * the generation entries `media()` serves, and its defaults seed the model roles `roles()` reports. It
 * is read on startup, on a credential change, and on request; its last good generation survives a
 * restart. Consumers that call the gateway themselves read `endpoint()` rather than configuring the
 * gateway a second time.
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
import { MediaCatalogSync, type MediaCatalogRecord, type MediaCatalogStore } from './media-sync.ts'
import { deriveRoles, domainRoleStore, memoryRoleStore, modelRolesDomain, MODEL_ROLES, type RoleStore } from './roles.ts'
import type {
  CatalogEntry, CatalogSyncResult, ClassMembers, GatewayCapability, MediaCatalogSnapshot, MediaGatewayEndpoint,
  MediaPreferences, ModelRole, ModelRoleState, ModelSyncResult,
} from './types.ts'
import { mergeCatalog } from './sync.ts'
import { DEFAULT_CATALOG_PATH, DEFAULT_CATALOG_TIMEOUT_MS } from './defaults.ts'

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
  /** Settings entry whose `models` field receives the catalog (default `llm-deepseek`). */
  readonly settingsNamespace?: string
  /** Provider id whose catalog-changed event the browser follows (default `deepseek-official`). */
  readonly provider?: string
  /** Path of the Hilo model catalog on the gateway origin (default `/api/v1/models/catalog`). */
  readonly catalogPath?: string
  /** Request budget of one catalog read, in milliseconds. */
  readonly timeoutMs?: number
}

/** Host service backing the generated `ctx.remote.suanliModels` namespace. */
export class SuanliModelCatalogService extends TypertRemoteService {
  static inject = ['credentials', 'settings', 'typert']

  static Config: z<Config> = z.object({
    baseURL: z.string().min(1),
    apiKeyEnv: z.string().role('credential-ref').min(1),
    catalogPath: z.string().pattern(/^\//u).default(DEFAULT_CATALOG_PATH),
    settingsNamespace: z.string().min(1).default('llm-deepseek'),
    provider: z.string().min(1).default('deepseek-official'),
    timeoutMs: z.natural().min(1).default(DEFAULT_CATALOG_TIMEOUT_MS),
  })

  private readonly ref: CredentialRef
  private readonly namespace: string
  private readonly provider: string
  private readonly origin: string
  private readonly catalogPath: string
  private readonly timeoutMs: number
  private readonly endpointFacts: MediaGatewayEndpoint
  /** How the last committed generation changed the chat catalog. */
  private lastModels: ModelSyncResult = { ok: false, reason: 'unreachable', kept: 0 }
  private roleStore: RoleStore = memoryRoleStore()
  private readonly send: typeof fetch = (input, init) => fetch(input, init)
  /** Snapshot served before the durable store is open and the first read has settled. */
  private readonly pending: MediaCatalogSnapshot = { status: 'loading', version: null, fetchedAt: null, entries: [] }
  private mediaSync: MediaCatalogSync | undefined
  private cache: { close(): Promise<void> } | undefined
  private rolesCache: { close(): Promise<void> } | undefined

  /**
   * @param ctx - Host context carrying the credential provider, settings, and Typert registry.
   * @param config - gateway endpoint, credential reference, and receiving settings entry.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'suanliModels', { namespace: 'suanliModels' })
    this.ref = credentialRef(config.apiKeyEnv)
    const {
      settingsNamespace = 'llm-deepseek',
      provider = 'deepseek-official',
      catalogPath = DEFAULT_CATALOG_PATH,
      timeoutMs = DEFAULT_CATALOG_TIMEOUT_MS,
    } = config
    this.namespace = settingsNamespace
    this.provider = provider
    this.origin = new URL(config.baseURL).origin
    this.catalogPath = catalogPath
    this.timeoutMs = timeoutMs
    this.endpointFacts = { baseURL: config.baseURL, credential: config.apiKeyEnv }
    ctx.effect(() => () => {
      void this.cache?.close()
      void this.rolesCache?.close()
    })
    ctx.on('credentials/reference-updated', (ref) => {
      if (ref !== this.ref) return
      void this.refreshMedia()
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
    // A read that commits a generation replaces this; a read with no models leaves it.
    this.lastModels = { ok: false, reason: 'empty-listing', kept: this.current().length }
    const media = await this.refreshMedia()
    if (media.status === 'unreachable' || media.status === 'rate-limited' || media.status === 'loading') {
      return { ok: false, reason: 'unreachable', kept: this.current().length }
    }
    const models = this.lastModels
    if (!models.ok) return models
    return {
      ...models,
      classes: this.classes(),
      capabilities: media.status === 'ready' || media.status === 'empty' || media.status === 'signed-out',
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
    return this.classes()
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

  /**
   * Read the models each role can use and which one it uses now.
   * @returns one state per role: chat, vision, image, video, music, speech.
   */
  @Remote
  roles(): readonly ModelRoleState[] {
    const chat = this.chat()
    return deriveRoles(this.media().entries, chat.text, chat.defaults, this.roleStore.choices())
  }

  /**
   * Choose the model one role uses.
   * @param role - a role other than chat, whose choice the conversation's model picker owns.
   * @param model - a candidate of the role, or `null` to return to the catalog default.
   * @returns the roles after the change.
   * @throws When the role is chat or the model is not a candidate of the role.
   */
  @Remote
  async selectRole(role: ModelRole, model: string | null): Promise<readonly ModelRoleState[]> {
    if (!MODEL_ROLES.includes(role) || role === 'chat') throw new Error(`role ${role} takes no choice here`)
    const listed = this.roles().some(state => state.role === role && state.candidates.some(candidate => candidate.model === model))
    if (model !== null && !listed) {
      throw new Error(`model ${model} is not a ${role} model of the catalog`)
    }
    await this.roleStore.choose(role, model)
    this.ctx.emit('suanli-model-catalog/roles-updated')
    return this.roles()
  }

  /**
   * Read the generation preferences.
   * @returns whether generated media is reviewed.
   */
  @Remote
  preferences(): MediaPreferences {
    return this.roleStore.preferences()
  }

  /**
   * Turn the review of generated images and videos on or off.
   * @param enabled - whether to review.
   * @returns the preferences after the change.
   */
  @Remote
  async setAutoReview(enabled: boolean): Promise<MediaPreferences> {
    await this.roleStore.setAutoReview(enabled)
    this.ctx.emit('suanli-model-catalog/roles-updated')
    return this.roleStore.preferences()
  }

  /** Open the durable generation store, seed the catalog from it, and read the gateway once. */
  private async startMedia(): Promise<void> {
    const mediaSync = new MediaCatalogSync({
      origin: this.origin,
      catalogPath: this.catalogPath,
      timeoutMs: this.timeoutMs,
      send: this.send,
      credential: async () => (await this.ctx.credentials.resolve(this.ref))?.value,
      store: await this.openStore(),
      now: () => Date.now(),
      report: (message) => { this.ctx.logger.warn(message) },
      changed: () => { this.ctx.emit('suanli-model-catalog/media-updated') },
      committed: async (record) => { await this.applyChat(record) },
    })
    this.roleStore = await this.openRoleStore()
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

  /**
   * Open the role choice domain, or degrade to process memory.
   * @returns the store role choices and preferences live in.
   */
  private async openRoleStore(): Promise<RoleStore> {
    const facility = this.ctx.get('storageDomain')
    if (facility === undefined) return memoryRoleStore()
    try {
      const domain = await facility.open(modelRolesDomain)
      this.rolesCache = domain
      return domainRoleStore({ choice: domain.table('choice'), preference: domain.table('preference') })
    } catch (error) {
      this.ctx.logger.warn('suanli model catalog: role choices are unavailable (%s); keeping them in memory', String(error))
      return memoryRoleStore()
    }
  }

  /**
   * Put the chat models of a committed generation in the route, writing only when they changed.
   * @param record - the generation now in effect.
   */
  private async applyChat(record: MediaCatalogRecord): Promise<void> {
    const previous = this.current()
    if (record.text.length === 0) {
      this.lastModels = { ok: false, reason: 'empty-listing', kept: previous.length }
      return
    }
    const merged = mergeCatalog(record.text.map(model => model.model), previous)
    const models: CatalogEntry[] = merged.map((entry) => {
      const listed = record.text.find(model => model.model === entry.id)
      // Chat routes accept text and image input; video support only feeds the vision role.
      const inputModalities = listed?.supportsImage === true ? ['text', 'image'] : ['text']
      return { ...entry, inputModalities }
    })
    const changed = JSON.stringify(previous) !== JSON.stringify(models)
    if (changed) {
      await this.ctx.settings.mutate(this.namespace, [{ op: 'set', path: ['models'], value: [...models] }])
      this.ctx.emit('llm/models-updated', this.provider)
    }
    this.lastModels = {
      ok: true,
      count: models.length,
      added: models.filter(model => !previous.some(entry => entry.id === model.id)).length,
      removed: previous.filter(entry => !models.some(model => model.id === entry.id)).length,
      changed,
    }
  }

  /** Chat models and role defaults of the generation in effect; none before the catalog opens. */
  private chat(): Pick<MediaCatalogRecord, 'text' | 'defaults'> {
    return this.mediaSync?.roles() ?? { text: [], defaults: { chat: null, multimodal: null } }
  }

  /** Capability classes of the generation in effect, chat and vision included. */
  private classes(): ClassMembers[] {
    const text = this.chat().text
    const chat: GatewayCapability[] = text.map(model => ({ operation: 'chat', model: model.model, taskTypes: [], maxReferenceImages: 0 }))
    const classes = classMembers([...chat, ...this.media().entries.map(asGatewayCapability)])
    const vision = (kind: 'image' | 'video'): ClassMembers[] => {
      const models = text.filter(model => kind === 'image' ? model.supportsImage : model.supportsVideo).map(model => model.model)
      return models.length === 0 ? [] : [{ capability: kind === 'image' ? 'vision.image' : 'vision.video', models }]
    }
    return [...classes.filter(entry => entry.capability === 'chat'), ...vision('image'), ...vision('video'),
      ...classes.filter(entry => entry.capability !== 'chat')]
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
