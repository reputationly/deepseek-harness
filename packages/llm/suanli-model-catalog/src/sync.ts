/** Framework-free merge of the catalog's chat models into the model route's catalog. */
import type { CatalogEntry } from './types.ts'

/**
 * Merge the catalog's chat models into the route: the catalog decides membership and order, while
 * an entry the deployment already knew keeps the facts the catalog does not carry.
 * @param ids - chat models the catalog lists, in order.
 * @param current - entries in effect before the refresh.
 * @returns the merged catalog.
 */
export function mergeCatalog(ids: readonly string[], current: readonly CatalogEntry[]): CatalogEntry[] {
  const known = new Map(current.map(entry => [entry.id, entry]))
  return ids.map((id) => {
    const previous = known.get(id)
    return previous === undefined ? { id } : previous
  })
}
