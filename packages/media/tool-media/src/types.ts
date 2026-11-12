/** Public type subpath of the media tools package: the Remote namespace's wire types. */
export interface MediaCapabilityView {
  /** Capability id the gateway publishes. */
  readonly id: string
  /** Model the capability calls. */
  readonly model: string
  /** Gateway operation, such as `generate_video`. */
  readonly operation: string
  /** Parameter names the model accepts. */
  readonly params: readonly string[]
}
