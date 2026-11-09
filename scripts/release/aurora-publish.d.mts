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
