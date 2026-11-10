/** Bucket key layout of one published Aurora build. */

/**
 * Object key for one artifact.
 * @param namespace - product namespace.
 * @param target - target directory.
 * @param version - publish version.
 * @param file - artifact file name.
 * @returns the bucket key.
 */
export declare function objectKey(namespace: string, target: string, version: string, file: string): string

/** Artifacts of one platform target and the feed filename its clients request. */
export interface AuroraTargetArtifacts {
  readonly feed: string
  readonly files: string[]
  readonly uploaded: Set<string>
}

/**
 * Group artifacts by target.
 * @param directory - electron-builder output directory.
 * @returns one entry per target with its files and feed.
 */
export declare function collect(directory: string): Map<string, AuroraTargetArtifacts>

/**
 * Rewrite one electron-builder feed so its URLs point at the versioned directory.
 * @param source - original feed text.
 * @param publicBase - public origin serving the bucket, without a trailing slash or namespace.
 * @param namespace - product namespace.
 * @param target - target directory.
 * @param version - publish version.
 * @returns the rewritten feed.
 */
export declare function rewriteFeed(source: string, publicBase: string, namespace: string, target: string, version: string): string

/**
 * Stable file name of one installer inside the floating directory.
 * @param namespace - product namespace.
 * @param target - target directory.
 * @param file - versioned artifact file name.
 * @returns the name the floating copy is published under.
 */
export declare function latestName(namespace: string, target: string, file: string): string

/** One file the current build of a target publishes. */
export interface AuroraIndexFile {
  readonly name: string
  readonly url: string
  readonly stableUrl: string
  readonly size: number
  readonly sha256: string
}

/** `latest.json` body: which build a target currently serves. */
export interface AuroraIndex {
  readonly product: string
  readonly target: string
  readonly version: string
  readonly publishedAt: string
  readonly feed: string
  readonly files: readonly AuroraIndexFile[]
}

/**
 * Build the `latest.json` body for one target.
 * @param options - publish inputs.
 * @returns the JSON text to upload.
 */
export declare function buildIndex(options: {
  namespace: string
  publicBase: string
  target: string
  version: string
  feed: string
  files: string[]
  artifacts: string
}): string
