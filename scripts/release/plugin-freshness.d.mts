/** One external plugin `apps/cli/package.json` pins to a commit of its `dist` branch. */
export interface PinnedPlugin {
  readonly name: string
  readonly owner: string
  readonly repo: string
  /** `dist` commit the raw URL names. */
  readonly sha: string
  readonly file: string
}

/** A pinned plugin whose `dist` branch has moved past the pinned commit. */
export interface StalePlugin {
  readonly name: string
  readonly pinned: string
  readonly head: string
}

/**
 * Read the plugins a manifest pins by raw `dist` URL.
 * @param manifestText - text of `apps/cli/package.json`.
 * @returns every dependency whose spec is a commit-pinned raw tarball URL.
 */
export declare function pinnedPlugins(manifestText: string): PinnedPlugin[]

/**
 * Compare pins with the current `dist` heads.
 * @param pins - plugins from {@link pinnedPlugins}.
 * @param heads - `dist` head commit per `owner/repo`.
 * @returns the plugins whose `dist` has a newer commit; throws for a repository with no `dist`.
 */
export declare function stalePlugins(pins: readonly PinnedPlugin[], heads: ReadonlyMap<string, string>): StalePlugin[]
