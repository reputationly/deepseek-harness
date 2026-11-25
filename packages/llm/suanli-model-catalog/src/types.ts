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

/** Result of one model-listing refresh. */
export type ModelSyncResult =
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

/** Result of one refresh, as the browser renders it: the listing plus the capability catalog read with it. */
export type CatalogSyncResult =
  | (Extract<ModelSyncResult, { ok: true }> & {
    /** Capability classes the gateway declared, empty when none were read. */
    readonly classes: readonly ClassMembers[]
    /** Whether this refresh also read the capability catalog. */
    readonly capabilities: boolean
  })
  | Extract<ModelSyncResult, { ok: false }>

/** One gateway listing row, as decoded from `{ data: [{ id }] }`. */
export interface ListedRow {
  readonly id: string
}

/** One localized label a gateway capability declares. */
export interface LocalizedLabel {
  /** Chinese text, empty when the gateway declares none. */
  readonly zh: string
  /** English text, empty when the gateway declares none. */
  readonly en: string
}

/** One parameter a capability's schema declares. */
export interface CapabilityParameter {
  /** JSON type the gateway reports; sliders also report `string`. */
  readonly type: string
  /** Label the form shows. */
  readonly title?: string
  /** Accepted values, for a parameter restricted to a set. */
  readonly enum?: readonly string[]
  /** Lower bound of a bounded parameter. */
  readonly minimum?: number
  /** Upper bound of a bounded parameter. */
  readonly maximum?: number
  /** Value used when the caller sends none. */
  readonly default?: string
}

/** Parameter object one capability declares. */
export interface CapabilityParameterSchema {
  /** Always `object`. */
  readonly type: string
  /** Declared parameters by name. */
  readonly properties: Readonly<Record<string, CapabilityParameter>>
}

/** How many inputs of one kind a mode accepts. */
export interface MediaReferenceRule {
  /** Fewest inputs the gateway accepts. */
  readonly min: number
  /** Most inputs the gateway accepts; zero when the mode takes none. */
  readonly max: number
}

/** Reference rules of one mode. */
export interface ModeReferences {
  /** Image inputs the mode accepts. */
  readonly image: MediaReferenceRule
  /** Video inputs the mode accepts. */
  readonly video: MediaReferenceRule
  /** Audio inputs the mode accepts. */
  readonly audio: MediaReferenceRule
}

/** One play a capability declares; its id is the `image_mode` a submission sends. */
export interface CapabilityMode {
  /** Submission value of `metadata.image_mode`. */
  readonly id: string
  /** Name the form shows. */
  readonly label: LocalizedLabel
  /** Equivalent `metadata.task_type`, which a submission may send instead. */
  readonly taskType: string
  /** Task type a single-image submission of a frame mode becomes. */
  readonly taskTypeIfSingleImage?: string
  /** Reference rules of this mode. */
  readonly references: ModeReferences
  /** Whether a submission must carry a source video, as continuation does. */
  readonly requiresSourceVideo?: boolean
  /** Note the form shows beside the mode. */
  readonly note?: LocalizedLabel
}

/** Declared hard limits of one capability; zero means the gateway declares none. */
export interface CapabilityLimits {
  /** Most reference inputs any mode of this capability accepts. */
  readonly maxReferenceImages: number
  /** Longest clip the capability produces. */
  readonly maxDurationSeconds: number
  /** Largest input file the capability accepts. */
  readonly maxInputBytes: number
}

/** One entry of the gateway capability catalog, in the fields a media workbench consumes. */
export interface CapabilityEntry {
  /** `<operation>:<model>`, unique within one catalog. */
  readonly id: string
  /** Operation the entry serves, such as `generate_image`. */
  readonly operation: string
  /** Wire model id a submission sends. */
  readonly model: string
  /** Name the form shows. */
  readonly displayName: LocalizedLabel
  /** One-line description the form shows. */
  readonly description: LocalizedLabel
  /** Transport the entry is called through; its `kind` selects the endpoint. */
  readonly transport: { readonly kind: string }
  /** Task types the entry declares, when its transport has any. */
  readonly taskTypes?: readonly string[]
  /** Parameters the entry accepts. */
  readonly paramSchema?: CapabilityParameterSchema
  /** Declared hard limits. */
  readonly limits: CapabilityLimits
  /** Seconds the capability actually delivers for each requestable duration. */
  readonly deliveryDurations?: readonly number[]
  /** Plays the entry declares; absent means the entry has a single play. */
  readonly modes?: readonly CapabilityMode[]
  /** Whether the gateway names this entry the default of its operation. */
  readonly default: boolean
}

/** Status the media workbench renders for the catalog. */
export type MediaCatalogStatus =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'signed-out'
  | 'unauthorized'
  | 'kyc-required'
  | 'rate-limited'
  | 'unreachable'

/** Media catalog as the workbench reads it. */
export interface MediaCatalogSnapshot {
  /** Outcome of the last refresh. */
  readonly status: MediaCatalogStatus
  /** Version of the last successful catalog, absent before one arrives. */
  readonly version: string | null
  /** When the last successful catalog was read. */
  readonly fetchedAt: number | null
  /** Entries of the last successful catalog, every operation included. */
  readonly entries: readonly CapabilityEntry[]
}

/** Gateway facts a consumer needs to call the same gateway a catalog came from. */
export interface MediaGatewayEndpoint {
  /** Gateway root carrying its API prefix, such as `https://maas.example.com/v1`. */
  readonly baseURL: string
  /** Credential reference holding the gateway key. */
  readonly credential: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The media catalog committed a change to its status or version.
     * @mode emit
     */
    'suanli-model-catalog/media-updated'(): void
  }
}
