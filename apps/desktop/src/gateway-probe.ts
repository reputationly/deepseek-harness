/** Validity check for a model-gateway API key, used by the first-run gate and every cold start. */

/** Outcome of probing the gateway with one key. */
export type GatewayKeyVerdict = 'ok' | 'invalid' | 'unreachable'

const PROBE_TIMEOUT_MS = 8000

/**
 * Ask the gateway which models one key may use.
 * @param baseURL - gateway root that already carries its API prefix.
 * @param apiKey - candidate key; sent as both bearer and `x-api-key` so either relay convention authenticates.
 * @param send - HTTP client, injectable for tests.
 * @returns `ok` for a listing response, `invalid` for a rejected key, `unreachable` for transport or server failure.
 */
export async function probeGatewayKey(
  baseURL: string,
  apiKey: string,
  send: typeof fetch = fetch,
): Promise<GatewayKeyVerdict> {
  const url = `${baseURL.replace(/\/+$/u, '')}/models`
  let response: Response
  try {
    response = await send(url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    return 'unreachable'
  }
  if (response.ok) return 'ok'
  if (response.status === 401 || response.status === 403) return 'invalid'
  return 'unreachable'
}
