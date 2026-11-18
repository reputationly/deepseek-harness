/** One capability class the settings surface groups models under. */
export type CapabilityClass =
  | 'chat'
  | 'vision.image'
  | 'vision.video'
  | 'image.generate'
  | 'image.edit'
  | 'video.generate'
  | 'video.first-last-frame'
  | 'video.reference'
  | 'music.generate'
  | 'speech.generate'
  | 'other'

/** One gateway capability entry, in the fields this product reads. */
export interface GatewayCapability {
  /** Gateway operation: `chat`, `generate_image`, `generate_video`, `generate_music`, … */
  readonly operation: string
  /** Wire model id the operation drives. */
  readonly model: string
  /** Task types the entry declares, when its transport has any. */
  readonly taskTypes: readonly string[]
  /** How many reference inputs the entry accepts; zero when it takes none. */
  readonly maxReferenceImages: number
}

/** Models one class holds, in catalog order. */
export interface ClassMembers {
  readonly capability: CapabilityClass
  readonly models: readonly string[]
}

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
    /** Capability classes the gateway declared, empty when none were read. */
    readonly classes: readonly ClassMembers[]
    /** Whether this refresh also read the capability catalog. */
    readonly capabilities: boolean
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
