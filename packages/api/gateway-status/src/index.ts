/**
 * Host Remote namespace reporting whether the model gateway this deployment
 * routes calls through answers for the stored key.
 *
 * A client surface renders the observation as one connection light, so the
 * reported codes separate a key the gateway refuses from an endpoint that
 * cannot be reached. The probe reads the credential by reference at every run:
 * a key replaced in settings reaches the next probe without a restart.
 *
 * @module @deepseek-ai/dsh-api-gateway-status
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { probeGatewayKey, PROBE_TIMEOUT_MS, type ProbeResult } from './probe.ts'
import { GatewayStatusCache } from './status.ts'
import type { GatewayStatus } from './types.ts'

export { probeGatewayKey, PROBE_TIMEOUT_MS } from './probe.ts'
export type { ProbeResult } from './probe.ts'
export { GatewayStatusCache } from './status.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `gatewayStatus` Remote namespace. */
    gatewayStatus: GatewayStatusService
  }
}

/** Gateway health policy: the endpoint to ask and the credential that authorizes the question. */
export interface Config {
  /** Gateway root that already carries its API prefix, the same endpoint model calls use. */
  readonly baseURL: string
  /** Credential reference holding the key; resolved at every probe. */
  readonly apiKeyEnv: string
  /** Request budget per probe, in milliseconds (default 8000). */
  readonly timeoutMs?: number
}

/** Host service backing the generated `ctx.remote.gatewayStatus` namespace. */
export class GatewayStatusService extends TypertRemoteService {
  static inject = ['credentials', 'typert']

  static Config: z<Config> = z.object({
    baseURL: z.string().min(1),
    apiKeyEnv: z.string().role('credential-ref').min(1),
    timeoutMs: z.natural().min(1).default(PROBE_TIMEOUT_MS),
  })

  private readonly ref: CredentialRef
  private readonly cache: GatewayStatusCache

  /**
   * @param ctx - Host context carrying the credential provider and the Typert registry.
   * @param config - gateway endpoint, credential reference, and probe budget.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'gatewayStatus', { namespace: 'gatewayStatus' })
    const baseURL = config.baseURL
    const timeoutMs = config.timeoutMs ?? PROBE_TIMEOUT_MS
    this.ref = credentialRef(config.apiKeyEnv)
    this.cache = new GatewayStatusCache(() => this.probe(baseURL, timeoutMs))
  }

  /**
   * Report the latest observation without asking the gateway.
   * @returns the cached status; `checking` until the first probe settles.
   */
  @Remote
  read(): GatewayStatus {
    return this.cache.current()
  }

  /**
   * Probe the gateway now, sharing any probe already in flight.
   * @returns the settled observation.
   */
  @Remote
  refresh(): Promise<GatewayStatus> {
    return this.cache.refresh()
  }

  private async probe(baseURL: string, timeoutMs: number): Promise<ProbeResult> {
    const stored = await this.ctx.credentials.resolve(this.ref)
    const key = stored?.value.trim() ?? ''
    if (key === '') return { code: 'no-key' }
    return probeGatewayKey(baseURL, key, undefined, timeoutMs)
  }
}

export default GatewayStatusService
