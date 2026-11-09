/**
 * Capability catalog of the product gateway (`GET /v1/ov/capabilities`): which media models the
 * current key may call and the parameter values each accepts.
 *
 * Fetched per key, held in memory for a short TTL, and mirrored to disk keyed by a key digest so a
 * gateway outage falls back to the last catalog that key saw. A key change never reuses another
 * key's catalog.
 * @module
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One enumerated parameter of a capability. */
export interface CapabilityParam {
  readonly type?: string
  readonly title?: string
  readonly enum?: readonly string[]
  readonly default?: string
}

/** Upper bounds the gateway enforces for one capability; zero means unbounded. */
export interface CapabilityLimits {
  readonly maxReferenceImages?: number
  readonly maxDurationSeconds?: number
  readonly maxInputBytes?: number
}

/** One callable operation on one gateway model. */
export interface Capability {
  readonly id: string
  readonly operation: string
  readonly model: string
  readonly taskTypes?: readonly string[]
  readonly paramSchema?: { readonly properties?: Readonly<Record<string, CapabilityParam>> }
  readonly limits?: CapabilityLimits
  readonly default?: boolean
}

/** The catalog one key sees, and whether it came from the gateway or the disk mirror. */
export interface MediaCatalog {
  readonly version: string
  readonly capabilities: readonly Capability[]
  readonly source: 'live' | 'cache'
}

/** Construction options for {@link CatalogSource}. */
export interface CatalogSourceOptions {
  /** Gateway root including its API prefix. */
  readonly baseURL: string
  /** Disk mirror path. */
  readonly cacheFile: string
  /** Memory TTL. */
  readonly ttlMs?: number
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

interface StoredCatalog {
  readonly version: string
  readonly capabilities: readonly Capability[]
}

/**
 * Catalog endpoint for a gateway root.
 * @param baseURL - gateway root such as `https://host/v1`.
 * @returns the absolute capability catalog URL.
 */
export function catalogURL(baseURL: string): string {
  const url = new URL(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/u, '').replace(/\/v1$/u, '')}/v1/ov/capabilities`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/**
 * Stable, non-reversible cache key for one API key.
 * @param apiKey - the key itself.
 * @returns a short hex digest.
 */
export function keyDigest(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 24)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a catalog response body.
 * @param body - parsed JSON.
 * @returns the catalog, or undefined when the body has no usable capability list.
 */
export function parseCatalog(body: unknown): StoredCatalog | undefined {
  if (!record(body) || !Array.isArray(body.capabilities)) return undefined
  const capabilities = body.capabilities.filter((entry): entry is Capability =>
    record(entry) && typeof entry.operation === 'string' && typeof entry.model === 'string' && entry.model !== '')
  return { version: typeof body.version === 'string' ? body.version : '', capabilities }
}

/** Per-key catalog reader with a memory TTL and a disk fallback. */
export class CatalogSource {
  private readonly memory = new Map<string, { readonly at: number; readonly catalog: StoredCatalog }>()
  private readonly ttlMs: number
  private readonly send: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: CatalogSourceOptions) {
    this.ttlMs = options.ttlMs ?? 60_000
    this.send = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  /**
   * Read the catalog the key sees.
   * @param apiKey - key sent as the bearer credential.
   * @param signal - cancellation of the calling tool.
   * @returns the live catalog, or the last mirrored one when the gateway cannot answer.
   * @throws {Error} when the gateway cannot answer and no catalog was ever mirrored for this key.
   */
  async load(apiKey: string, signal?: AbortSignal): Promise<MediaCatalog> {
    const digest = keyDigest(apiKey)
    const cached = this.memory.get(digest)
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) return { ...cached.catalog, source: 'live' }
    let failure: unknown
    try {
      const response = await this.send(catalogURL(this.options.baseURL), {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
        ...signal === undefined ? {} : { signal },
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const catalog = parseCatalog(await response.json())
      if (catalog === undefined) throw new Error('response has no capability list')
      this.memory.set(digest, { at: this.now(), catalog })
      if (cached?.catalog.version !== catalog.version || cached.catalog.version === '') await this.mirror(digest, catalog)
      return { ...catalog, source: 'live' }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      failure = error
    }
    const stale = cached?.catalog ?? (await this.readMirror())[digest]
    if (stale !== undefined) return { ...stale, source: 'cache' }
    throw new Error(`capability catalog unavailable: ${failure instanceof Error ? failure.message : String(failure)}`)
  }

  private async readMirror(): Promise<Record<string, StoredCatalog>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.cacheFile, 'utf8'))
      if (!record(parsed) || !record(parsed.entries)) return {}
      const entries: Record<string, StoredCatalog> = {}
      for (const [digest, value] of Object.entries(parsed.entries)) {
        const catalog = parseCatalog(value)
        if (catalog !== undefined) entries[digest] = catalog
      }
      return entries
    } catch {
      return {}
    }
  }

  private async mirror(digest: string, catalog: StoredCatalog): Promise<void> {
    try {
      const entries = { ...await this.readMirror(), [digest]: catalog }
      await mkdir(dirname(this.options.cacheFile), { recursive: true })
      const temporary = `${this.options.cacheFile}.${String(process.pid)}.tmp`
      await writeFile(temporary, JSON.stringify({ entries }), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.options.cacheFile)
    } catch {
      // The mirror only serves outages; a failed write leaves the live catalog in use.
    }
  }
}

/**
 * Capabilities for one operation, the gateway's default first.
 * @param catalog - catalog the key sees.
 * @param operation - such as `generate_image`.
 * @returns matching capabilities in preference order.
 */
export function capabilitiesFor(catalog: MediaCatalog, operation: string): Capability[] {
  const matching = catalog.capabilities.filter(capability => capability.operation === operation)
  return [...matching.filter(capability => capability.default === true), ...matching.filter(capability => capability.default !== true)]
}
