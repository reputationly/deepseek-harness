/**
 * Cached gateway observation: one probe at a time, and every reader sees the
 * same settled result.
 *
 * @module @deepseek-ai/dsh-api-gateway-status/src/status
 */

import type { ProbeResult } from './probe.ts'
import type { GatewayStatus } from './types.ts'

/**
 * Hold the latest observation and collapse concurrent refreshes onto one probe.
 * A reader that asks while a probe runs joins it instead of starting another, so
 * several surfaces polling at once still cost the gateway one request.
 */
export class GatewayStatusCache {
  private status: GatewayStatus = { state: 'checking', code: 'unreachable' }
  private inflight: Promise<GatewayStatus> | undefined

  /**
   * @param probe - probe to run; it must not throw, and its rejection is reported as a failure.
   * @param now - clock used for `checkedAt`, injectable for tests.
   */
  constructor(
    private readonly probe: () => Promise<ProbeResult>,
    private readonly now: () => number = Date.now,
  ) {}

  /** @returns the latest observation without asking the gateway. */
  current(): GatewayStatus {
    return this.status
  }

  /** @returns the settled observation; concurrent callers share one probe. */
  refresh(): Promise<GatewayStatus> {
    if (this.inflight !== undefined) return this.inflight
    this.status = { ...this.status, state: 'checking' }
    const run = this.probe().then((outcome) => {
      this.status = {
        state: outcome.code === 'connected' ? 'connected' : 'disconnected',
        code: outcome.code,
        ...outcome.detail === undefined ? {} : { detail: outcome.detail },
        checkedAt: this.now(),
      }
      return this.status
    }, (error: unknown) => {
      this.status = {
        state: 'disconnected',
        code: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
        checkedAt: this.now(),
      }
      return this.status
    }).finally(() => { this.inflight = undefined })
    this.inflight = run
    return run
  }
}
