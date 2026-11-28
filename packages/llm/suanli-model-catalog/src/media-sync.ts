/** Refresh of the Hilo model catalog: status mapping, coalescing, and durable reuse of the last good read. */
import { decodeHiloCatalog } from './hilo.ts'
import { mediaEntries } from './media.ts'
import type { CapabilityEntry, HiloDefaults, HiloTextModel, MediaCatalogSnapshot, MediaCatalogStatus } from './types.ts'

/** One durable catalog generation. */
export interface MediaCatalogRecord {
  /** Version the gateway stamped, absent when it declares none. */
  readonly version: string | null
  /** When this generation was read, in milliseconds. */
  readonly fetchedAt: number
  /** Every generation entry of the generation. */
  readonly entries: readonly CapabilityEntry[]
  /** Chat models of the generation. */
  readonly text: readonly HiloTextModel[]
  /** Role defaults of the generation. */
  readonly defaults: HiloDefaults
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
  /** Path of the Hilo model catalog, such as `/api/v1/models/catalog`. */
  readonly catalogPath: string
  /** Request budget of one read. */
  readonly timeoutMs: number
  /** Transport used for the read; injectable so tests own their bytes. */
  readonly send: typeof fetch
  /**
   * Resolve the gateway key; the catalog is read anonymously, the key only decides `signed-out`.
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
  /**
   * Put the chat models of a committed generation in effect.
   * @param record - the generation now in effect.
   */
  readonly committed: (record: MediaCatalogRecord) => Promise<void>
}

/**
 * Read the gateway capability catalog and keep the last good generation in effect.
 *
 * A failed, empty, or unreadable read never clears the entries, the version, or the fetch time: the
 * workbench keeps rendering the previous catalog and reads the status to explain why.
 */
export class MediaCatalogSync {
  private snapshot: MediaCatalogSnapshot
  private chat: Pick<MediaCatalogRecord, 'text' | 'defaults'> = { text: [], defaults: { chat: null, multimodal: null } }
  private pending: Promise<MediaCatalogSnapshot> | undefined
  private invalidation = 0

  constructor(private readonly inputs: MediaCatalogSyncInputs) {
    this.snapshot = { status: 'loading', version: null, fetchedAt: null, entries: [] }
  }

  /** Seed the snapshot from the store the owner resolved, before the first read. */
  hydrate(): void {
    const stored = this.inputs.store.read()
    if (stored === undefined) return
    const previous = this.snapshot
    this.snapshot = { status: previous.status, version: stored.version, fetchedAt: stored.fetchedAt, entries: stored.entries }
    this.chat = { text: stored.text, defaults: stored.defaults }
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
   * Chat models and role defaults in effect.
   * @returns the text section and defaults of the last committed generation.
   */
  roles(): Pick<MediaCatalogRecord, 'text' | 'defaults'> {
    return this.chat
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

  /**
   * Commit one already validated generation without another gateway read.
   * @param record - the generation now in effect.
   * @returns the snapshot after the commit.
   */
  async commit(record: MediaCatalogRecord): Promise<MediaCatalogSnapshot> {
    this.invalidation += 1
    const previous = this.snapshot
    const fresh = record.version === null || record.version !== previous.version
    if (fresh) {
      try {
        await this.inputs.store.write(record)
      } catch (error) {
        this.inputs.report(`model catalog: could not store the read catalog (${String(error)})`)
      }
    }
    const key = await this.inputs.credential()
    const status: MediaCatalogStatus = key === undefined || key === ''
      ? 'signed-out'
      : mediaEntries(record.entries).length === 0 ? 'empty' : 'ready'
    this.snapshot = { status, version: record.version, fetchedAt: record.fetchedAt, entries: record.entries }
    this.chat = { text: record.text, defaults: record.defaults }
    if (previous.status !== status || previous.version !== record.version) this.inputs.changed()
    try {
      await this.inputs.committed(record)
    } catch (error) {
      // A profile that pins the chat models refuses the write; the media catalog stays in effect.
      this.inputs.report(`model catalog: could not apply the chat models (${String(error)})`)
    }
    return this.snapshot
  }

  /** Read one generation and commit it when it is usable. */
  private async read(): Promise<MediaCatalogSnapshot> {
    const invalidation = this.invalidation
    let response: Response
    try {
      response = await this.inputs.send(new URL(this.inputs.catalogPath, this.inputs.origin).href, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.inputs.timeoutMs),
      })
    } catch {
      return this.settle('unreachable')
    }
    if (response.status === 429) return this.settle('rate-limited')
    if (!response.ok) return this.settle('unreachable')
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return this.settle('unreachable')
    }
    const decoded = decodeHiloCatalog(payload)
    if (decoded === undefined) return this.settle('unreachable')
    if (decoded.dropped > 0) {
      this.inputs.report(`model catalog: dropped ${String(decoded.dropped)} entr${decoded.dropped === 1 ? 'y' : 'ies'} without an id or platform model`)
    }
    const previous = this.snapshot
    if (decoded.unknownInterfaces.length > 0 && decoded.version !== previous.version) {
      this.inputs.report(`model catalog: unknown interface types ${decoded.unknownInterfaces.join(', ')}; using each section's default`)
    }
    if (mediaEntries(decoded.entries).length === 0 && decoded.text.length === 0) return this.settle('empty')
    const record: MediaCatalogRecord = {
      version: decoded.version, fetchedAt: this.inputs.now(), entries: decoded.entries, text: decoded.text, defaults: decoded.defaults,
    }
    if (invalidation !== this.invalidation) return this.snapshot
    return await this.commit(record)
  }
}
