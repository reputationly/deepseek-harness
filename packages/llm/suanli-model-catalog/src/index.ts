/**
 * Host Remote namespace that refreshes the product's model catalog from its gateway.
 *
 * The route's `models` field is volatile configuration, so the catalog this service writes
 * takes effect for the running route without a restart: the gateway's listing becomes what
 * the model picker offers. A refresh never clears the catalog — a failed or empty listing
 * keeps the entries already in effect and reports why.
 *
 * @module @deepseek-ai/dsh-suanli-model-catalog
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CatalogSync } from './sync.ts'
import type { CatalogEntry, CatalogSyncResult } from './types.ts'

export { CatalogSync, mergeCatalog } from './sync.ts'
export type * from './types.ts'

/** Default listing path of an OpenAI-compatible gateway. */
export const DEFAULT_CATALOG_MODELS_PATH = '/v1/models'
/** Default request budget of one listing. */
export const DEFAULT_CATALOG_TIMEOUT_MS = 10_000

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
    settingsNamespace: z.string().min(1).default('llm-deepseek'),
    provider: z.string().min(1).default('deepseek-official'),
    timeoutMs: z.natural().min(1).default(DEFAULT_CATALOG_TIMEOUT_MS),
    endpointTypes: z.array(z.string().min(1)).default(['openai']),
  })

  private readonly ref: CredentialRef
  private readonly namespace: string
  private readonly provider: string
  private readonly sync: CatalogSync

  /**
   * @param ctx - Host context carrying the credential provider, settings, and Typert registry.
   * @param config - gateway endpoint, credential reference, and receiving settings entry.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'suanliModels', { namespace: 'suanliModels' })
    this.ref = credentialRef(config.apiKeyEnv)
    this.namespace = config.settingsNamespace ?? 'llm-deepseek'
    this.provider = config.provider ?? 'deepseek-official'
    const origin = new URL(config.baseURL).origin
    this.sync = new CatalogSync({
      origin,
      modelsPath: config.modelsPath ?? DEFAULT_CATALOG_MODELS_PATH,
      timeoutMs: config.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
      endpointTypes: config.endpointTypes,
      send: (input, init) => fetch(input, init),
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
  }

  /**
   * Refresh the catalog from the gateway and put it in effect.
   * @returns how the catalog changed, or why it stayed as it was.
   */
  @Remote
  refresh(): Promise<CatalogSyncResult> {
    return this.sync.refresh()
  }

  /**
   * Read the entries the route offers now, without contacting the gateway.
   * @returns the catalog in effect.
   */
  @Remote
  read(): readonly CatalogEntry[] {
    return this.current()
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
