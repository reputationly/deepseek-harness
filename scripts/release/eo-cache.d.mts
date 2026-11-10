/** Cache work one published release implies for EdgeOne. */

/** URLs an EdgeOne zone still has to learn about after a publish. */
export interface EdgeOneCachePlan {
  /** Immutable installer URLs to pre-warm so no user pays for the first origin pull. */
  readonly warm: string[]
  /** Pointers to refresh so a client stops seeing the previous release. */
  readonly refresh: string[]
}

/**
 * Read one staged index and derive the work it implies.
 * @param file - path to a `latest.json` the publish step wrote.
 * @returns installer URLs to pre-warm, and pointers to refresh.
 */
export declare function planFromIndex(file: string): EdgeOneCachePlan
