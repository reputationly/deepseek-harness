/** Refresh of the gateway's media catalog: status mapping, coalescing, and durable reuse of the last good read. */
import { decodeCatalog, mediaEntries } from './media.ts'
import type { CapabilityEntry, MediaCatalogSnapshot, MediaCatalogStatus } from './types.ts'

/** One durable catalog generation. */
export interface MediaCatalogRecord {
  /** Version the gateway stamped, absent when it declares none. */
  readonly version: string | null
  /** When this generation was read, in milliseconds. */
  readonly fetchedAt: number
  /** Every entry of the generation. */
  readonly entries: readonly CapabilityEntry[]
}

/** Durable storage of the last good catalog generation. */
export interface MediaCatalogStore {
  /**
   * Read the stored generation.
   * @returns the generation, or `undefined` when nothing usable is stored.
   */
  read(): MediaCatalogRecord | undefined
  /**
   * Store one generation.
   * @param record - the generation to keep.
   */
  write(record: MediaCatalogRecord): Promise<void>
}

/** Inputs of one media catalog refresh. */
export interface MediaCatalogSyncInputs {
  /** Origin of the gateway this deployment routes through. */
  readonly origin: string
  /** Path of the gateway capability catalog, such as `/v1/ov/capabilities`. */
  readonly capabilitiesPath: string
  /** Request budget of one read. */
  readonly timeoutMs: number
  /** Transport used for the read; injectable so tests own their bytes. */
  readonly send: typeof fetch
  /**
   * Resolve the gateway key.
   * @returns the key, or `undefined` when this deployment stores none.
   */
  readonly credential: () => Promise<string | undefined>
  /** Durable generation store. */
  readonly store: MediaCatalogStore
  /** Current time in milliseconds; injectable so tests own their clock. */
  readonly now: () => number
  /**
   * Report one dropped entry or unreadable generation.
   * @param message - diagnostic text, never containing the key.
   */
  readonly report: (message: string) => void
  /** Called after a change to the status or version is committed. */
  readonly changed: () => void
}

/**
 * Read the gateway capability catalog and keep the last good generation in effect.
 *
 * A failed, empty, or unreadable read never clears the entries, the version, or the fetch time: the
 * workbench keeps rendering the previous catalog and reads the status to explain why.
 */
export class MediaCatalogSync {
  private snapshot: MediaCatalogSnapshot
  private pending: Promise<MediaCatalogSnapshot> | undefined

  constructor(private readonly inputs: MediaCatalogSyncInputs) {
    this.snapshot = { status: 'loading', version: null, fetchedAt: null, entries: [] }
  }

  /** Seed the snapshot from the store the owner resolved, before the first read. */
  hydrate(): void {
    const stored = this.inputs.store.read()
    if (stored === undefined) return
    const previous = this.snapshot
    this.snapshot = { status: previous.status, version: stored.version, fetchedAt: stored.fetchedAt, entries: stored.entries }
    if (previous.entries.length === 0) this.inputs.changed()
  }

  /**
   * Catalog in effect.
   * @returns the last committed snapshot.
   */
  current(): MediaCatalogSnapshot {
    return this.snapshot
  }

  /**
   * Refresh the catalog, joining a refresh already in flight.
   * @returns the snapshot in effect once the read settles.
   */
  refresh(): Promise<MediaCatalogSnapshot> {
    this.pending ??= this.read().finally(() => { this.pending = undefined })
    return this.pending
  }

  /** Publish one status without touching the entries the workbench renders. */
  private settle(status: MediaCatalogStatus): MediaCatalogSnapshot {
    const previous = this.snapshot
    this.snapshot = { ...previous, status }
    if (previous.status !== status) this.inputs.changed()
    return this.snapshot
  }

  /** Read one generation and commit it when it is usable. */
  private async read(): Promise<MediaCatalogSnapshot> {
    const key = await this.inputs.credential()
    if (key === undefined || key === '') return this.settle('signed-out')
    let response: Response
    try {
      response = await this.inputs.send(new URL(this.inputs.capabilitiesPath, this.inputs.origin).href, {
        headers: { authorization: `Bearer ${key}`, 'x-api-key': key, accept: 'application/json' },
        signal: AbortSignal.timeout(this.inputs.timeoutMs),
      })
    } catch {
      return this.settle('unreachable')
    }
    if (response.status === 401) return this.settle('unauthorized')
    if (response.status === 403) return this.settle(await this.requiresVerification(response) ? 'kyc-required' : 'unauthorized')
    if (response.status === 429) return this.settle('rate-limited')
    if (!response.ok) return this.settle('unreachable')
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return this.settle('unreachable')
    }
    const decoded = decodeCatalog(payload)
    if (decoded === undefined) return this.settle('unreachable')
    if (decoded.dropped > 0) {
      this.inputs.report(`media catalog: dropped ${String(decoded.dropped)} entr${decoded.dropped === 1 ? 'y' : 'ies'} without an id, operation, model, or transport`)
    }
    if (mediaEntries(decoded.entries).length === 0) return this.settle('empty')
    const previous = this.snapshot
    const record: MediaCatalogRecord = { version: decoded.version, fetchedAt: this.inputs.now(), entries: decoded.entries }
    if (record.version === null || record.version !== previous.version) {
      try {
        await this.inputs.store.write(record)
      } catch (error) {
        this.inputs.report(`media catalog: could not store the read catalog (${String(error)})`)
      }
    }
    this.snapshot = { status: 'ready', version: record.version, fetchedAt: record.fetchedAt, entries: record.entries }
    if (previous.status !== 'ready' || previous.version !== record.version) this.inputs.changed()
    return this.snapshot
  }

  /**
   * Whether a rejected read is the gateway's verification gate rather than a rejected key.
   * @param response - the 403 answer, whose body is consumed here.
   * @returns true when the body carries the gateway's `kyc_required` code.
   */
  private async requiresVerification(response: Response): Promise<boolean> {
    try {
      const body = await response.json() as { error?: { code?: unknown } }
      return body.error?.code === 'kyc_required'
    } catch {
      return false
    }
  }
}
