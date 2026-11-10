/** Why the last gateway probe ended as it did; the Client localizes every code. */
export type GatewayStatusCode = 'connected' | 'no-key' | 'key-rejected' | 'http-error' | 'unreachable'

/** Connection a status light renders. */
export type GatewayConnectionState = 'checking' | 'connected' | 'disconnected'

/**
 * One observation of the configured model gateway: whether the stored key is
 * answered by the endpoint this deployment routes model calls through.
 */
export interface GatewayStatus {
  /** Connection state the light shows. */
  readonly state: GatewayConnectionState
  /** Outcome of the probe behind `state`. */
  readonly code: GatewayStatusCode
  /** Gateway status text or transport message for `http-error` and `unreachable`; absent otherwise. */
  readonly detail?: string
  /** Epoch milliseconds when the probe behind this status finished; absent before the first one does. */
  readonly checkedAt?: number
}
