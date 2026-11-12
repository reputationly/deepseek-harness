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
