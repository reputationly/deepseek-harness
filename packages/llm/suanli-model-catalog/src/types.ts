/** Shapes the model-catalog sync reports to the browser and to tests. */

/**
 * One catalog entry the sync writes into the model route.
 *
 * The route accepts these fields; `contextWindow` and `inputModalities` are carried over
 * from an entry this deployment already knew, because a gateway listing usually omits them.
 */
export interface CatalogEntry {
  /** Wire model id the route sends. */
  readonly id: string
  /** Combined request and response context the picker shows. */
  readonly contextWindow?: number
  /** Accepted input kinds. */
  readonly inputModalities?: readonly string[]
}

/** Why a refresh produced no new catalog. */
export type CatalogSyncFailure = 'no-credential' | 'unauthorized' | 'unreachable' | 'empty-listing'

/** Result of one refresh, as the browser renders it. */
export type CatalogSyncResult =
  | {
    /** Entries now in effect. */
    readonly ok: true
    /** How many entries the route now offers. */
    readonly count: number
    /** Entries the gateway listed that the catalog had not carried before. */
    readonly added: number
    /** Entries the previous catalog carried and the gateway no longer lists. */
    readonly removed: number
    /** Whether the merged catalog differs from the one in effect. */
    readonly changed: boolean
  }
  | {
    readonly ok: false
    readonly reason: CatalogSyncFailure
    /** Entries kept from the previous catalog; zero means the route offers nothing. */
    readonly kept: number
  }

/** One gateway listing row, as decoded from `{ data: [{ id }] }`. */
export interface ListedRow {
  readonly id: string
}
