/**
 * Probe one model-gateway key: ask the endpoint for the model list it serves.
 *
 * The answer separates the two failures a person must tell apart — a key the
 * gateway refuses, and an endpoint that cannot be reached at all — because the
 * surface above this probe reports them differently. The key travels only in
 * request headers and never reaches a log or a returned value.
 *
 * @module @deepseek-ai/dsh-api-gateway-status/src/probe
 */

import type { GatewayStatusCode } from './types.ts'

/** Default request budget for one probe, in milliseconds. */
export const PROBE_TIMEOUT_MS = 8_000

/** Outcome of one probe, without the observation wrapper. */
export interface ProbeResult {
  /** Which failure (or success) the gateway answered with. */
  readonly code: GatewayStatusCode
  /** Gateway status text or transport message for the two detail-carrying codes. */
  readonly detail?: string
}

/**
 * Ask the gateway which models one key may use.
 * @param baseURL - gateway root that already carries its API prefix.
 * @param apiKey - stored key; sent as both bearer and `x-api-key` so either relay convention authenticates.
 * @param send - HTTP client, injectable for tests.
 * @param timeoutMs - request budget in milliseconds.
 * @returns the outcome code, plus the gateway or transport detail where one explains it.
 */
export async function probeGatewayKey(
  baseURL: string,
  apiKey: string,
  send: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  let response: Response
  try {
    response = await send(`${baseURL.replace(/\/+$/u, '')}/models`, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { code: 'unreachable', detail: error instanceof Error ? error.message : String(error) }
  }
  // The listing body is not read; cancelling returns the connection to the pool.
  await response.body?.cancel().catch(() => undefined)
  if (response.ok) return { code: 'connected' }
  if (response.status === 401 || response.status === 403) return { code: 'key-rejected' }
  return { code: 'http-error', detail: `HTTP ${response.status}` }
}
