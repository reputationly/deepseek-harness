/** Durable and in-memory stores of the last good media catalog generation. */
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { decodeCatalog } from './media.ts'
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
  name: 'suanli-media-catalog',
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { snapshot: domainTable(snapshotSchema) },
})

/** One generation as the domain stores it. */
export type StoredSnapshot = z.infer<typeof snapshotSchema>

/**
 * Store the catalog in an opened domain table.
 * @param table - the opened `snapshot` table of {@link mediaCatalogDomain}.
 * @returns the store the sync reads and writes.
 */
export function domainCatalogStore(table: KvTable<string, StoredSnapshot>): MediaCatalogStore {
  return {
    read: () => decodeRecord(table.get(SNAPSHOT_KEY)),
    write: async (record) => {
      await table.put(SNAPSHOT_KEY, {
        version: record.version,
        fetchedAt: record.fetchedAt,
        payload: JSON.stringify({ version: record.version, capabilities: record.entries }),
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
    write: async (record) => { stored = record },
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
  if (decoded === undefined || decoded.entries.length === 0) return undefined
  return { version: stored.version, fetchedAt: stored.fetchedAt, entries: decoded.entries }
}
