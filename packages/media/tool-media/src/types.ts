/** Public type subpath of the media tools package: the Remote namespace's wire types. */

/** One parameter a capability accepts. */
export interface MediaParamView {
  /** Parameter name the gateway uses. */
  readonly id: string
  /** Human title from the catalog, when it carries one. */
  readonly title?: string
  /** Accepted values, when the parameter is enumerated. */
  readonly options?: readonly string[]
  /** Value the catalog recommends. */
  readonly default?: string
  /** Catalog type, such as `string`, `number`, or `boolean`. */
  readonly type?: string
}

/** One model and the parameters a Client may offer for it. */
export interface MediaCapabilityView {
  /** Capability id the gateway publishes. */
  readonly id: string
  /** Model the capability calls. */
  readonly model: string
  /** Gateway operation, such as `generate_video`. */
  readonly operation: string
  /** Parameters the model accepts. */
  readonly params: readonly MediaParamView[]
}

/** One node a generation plan would touch. */
export interface MediaPlanLine {
  /** Canvas node id. */
  readonly node: string
  /** Kind of media the node generates. */
  readonly kind: string
  /** Model the plan calls. */
  readonly model: string
  /** Model calls the node needs. */
  readonly calls: number
  /** Video seconds the node asks for. */
  readonly seconds?: number
}

/** What one generation plan costs. */
export interface MediaPlanTotals {
  readonly videoCalls: number
  readonly videoSeconds: number
  readonly imageCalls: number
  readonly speechLines: number
  readonly musicCalls: number
}

/** One generation job a plan started. */
export interface MediaJobRef {
  readonly node: string
  readonly jobId: string
}

/** Result of planning or starting one generation request. */
export interface MediaPlanView {
  /** What the Host decided to do. */
  readonly state: 'ready' | 'blocked' | 'needs_confirmation' | 'already_running' | 'started' | 'failed'
  /** Why the plan refuses or failed, when it did. */
  readonly message?: string
  /** Token to present once the user agrees to the totals. */
  readonly token?: string
  /** Per-node calls. */
  readonly lines: readonly MediaPlanLine[]
  /** Calls by kind. */
  readonly totals: MediaPlanTotals
  /** Jobs the plan started. */
  readonly jobs: readonly MediaJobRef[]
}
