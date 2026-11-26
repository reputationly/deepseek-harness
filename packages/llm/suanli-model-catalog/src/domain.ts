/** Durable and in-memory stores of the last good media catalog generation. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { decodeCatalog } from './media.ts'
import type { HiloDefaults, HiloTextModel } from './types.ts'
import type { MediaCatalogRecord, MediaCatalogStore } from './media-sync.ts'

/** Key one domain unit holds its single catalog generation under. */
const SNAPSHOT_KEY = 'current'

/** Stored form of one generation: the identity fields plus the payload re-decoded on read. */
const snapshotSchema = z.object({
  version: z.string().nullable(),
  fetchedAt: z.number(),
  payload: z.string(),
})

/**
 * Domain declaration of the media catalog cache.
 *
 * The payload stays one JSON string rather than a mirrored zod tree: the gateway extends entries with
 * fields this product ignores, and a strict mirror would reject a catalog it could otherwise render.
 * `backup-and-skip` treats a generation this package can no longer read as absent instead of failing the
 * open, because the catalog is derived data the next refresh replaces.
 */
export const mediaCatalogDomain = defineDomain({
  // 域名必须匹配存储域的 UNIT_NAME_RE（`^[a-z][a-z0-9_]*$`），因此用下划线而不是连字符。
  name: 'suanli_media_catalog',
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { snapshot: domainTable(snapshotSchema) },
})

/** One generation as the domain stores it. */
export type StoredSnapshot = z.infer<typeof snapshotSchema>

/** The two operations the catalog store needs from an opened table. */
export interface SnapshotTable {
  /**
   * Read the stored generation.
   * @param key - record key.
   * @returns the record, or `undefined` when absent.
   */
  get(key: string): StoredSnapshot | undefined
  /**
   * Store one generation durably.
   * @param key - record key.
   * @param value - the whole record.
   */
  put(key: string, value: StoredSnapshot): Promise<void>
}

/**
 * Store the catalog in an opened domain table.
 * @param table - the opened `snapshot` table of {@link mediaCatalogDomain}.
 * @returns the store the sync reads and writes.
 */
export function domainCatalogStore(table: SnapshotTable): MediaCatalogStore {
  return {
    read: () => decodeRecord(table.get(SNAPSHOT_KEY)),
    write: async (record) => {
      await table.put(SNAPSHOT_KEY, {
        version: record.version,
        fetchedAt: record.fetchedAt,
        payload: JSON.stringify({ version: record.version, capabilities: record.entries, text: record.text, defaults: record.defaults }),
      })
    },
  }
}

/**
 * Keep the catalog for this process only, for a deployment without the storage domain.
 * @returns a store whose contents end with the process.
 */
export function memoryCatalogStore(): MediaCatalogStore {
  let stored: MediaCatalogRecord | undefined
  return {
    read: () => stored,
    write: (record) => {
      stored = record
      return Promise.resolve()
    },
  }
}

/**
 * Decode one stored generation.
 * @param stored - record read from the domain table.
 * @returns the generation, or `undefined` when the payload no longer decodes.
 */
function decodeRecord(stored: StoredSnapshot | undefined): MediaCatalogRecord | undefined {
  if (stored === undefined) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(stored.payload)
  } catch {
    return undefined
  }
  const decoded = decodeCatalog(payload)
  if (decoded === undefined) return undefined
  const source = payload as { text?: unknown; defaults?: unknown }
  const text = storedText(source.text)
  if (decoded.entries.length === 0 && text.length === 0) return undefined
  return { version: stored.version, fetchedAt: stored.fetchedAt, entries: decoded.entries, text, defaults: storedDefaults(source.defaults) }
}

/**
 * Chat models of one stored generation; a generation stored before the text section was kept has none.
 * @param value - the stored `text` field.
 * @returns the chat models it still carries.
 */
function storedText(value: unknown): HiloTextModel[] {
  if (!Array.isArray(value)) return []
  return (value as unknown[]).flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    const { model, label, supportsImage, supportsVideo, supportsAudio } = row as Record<string, unknown>
    if (typeof model !== 'string' || model === '') return []
    return [{
      model,
      label: typeof label === 'string' && label !== '' ? label : model,
      supportsImage: supportsImage === true,
      supportsVideo: supportsVideo === true,
      supportsAudio: supportsAudio === true,
    }]
  })
}

/**
 * Role defaults of one stored generation.
 * @param value - the stored `defaults` field.
 * @returns the defaults, `null` where none is stored.
 */
function storedDefaults(value: unknown): HiloDefaults {
  const source = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const pick = (field: unknown): string | null => typeof field === 'string' && field !== '' ? field : null
  return { chat: pick(source.chat), multimodal: pick(source.multimodal) }
}
