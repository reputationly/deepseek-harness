// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { probeGatewayKey } from '../src/probe.ts'

function answer(status: number, body = ''): Response {
  return new Response(body, { status })
}

const reject = (): never => { throw new Error('asynchronously closed') }

/** A `fetch` stand-in the probe can call and the test can inspect. */
function sendStub(respond: () => Promise<Response>) {
  return vi.fn<typeof fetch>(respond)
}

/**
 * Read one recorded request.
 * @param send - the `fetch` stand-in passed to the probe.
 * @returns the URL and request init of the first call.
 */
function firstCall(send: ReturnType<typeof sendStub>): [string, RequestInit] {
  const [url, init] = send.mock.calls[0] ?? []
  if (typeof url !== 'string' || init === undefined) throw new Error('the probe recorded no request')
  return [url, init]
}

it('reports an answered key as connected and asks the listing endpoint with the key', async () => {
  const send = sendStub(async () => answer(200, '{"data":[]}'))
  await expect(probeGatewayKey('https://gateway.example/v1/', 'sk-test', send))
    .resolves.toEqual({ code: 'connected' })
  const [url, init] = firstCall(send)
  expect(url).toBe('https://gateway.example/v1/models')
  const headers = new Headers(init.headers)
  expect(headers.get('authorization')).toBe('Bearer sk-test')
  expect(headers.get('x-api-key')).toBe('sk-test')
})

it.each([401, 403])('reports HTTP %i as a refused key', async (status) => {
  const send = sendStub(async () => answer(status))
  await expect(probeGatewayKey('https://gateway.example/v1', 'sk-test', send))
    .resolves.toEqual({ code: 'key-rejected' })
})

it('carries the gateway status of any other refusal', async () => {
  const send = sendStub(async () => answer(503))
  await expect(probeGatewayKey('https://gateway.example/v1', 'sk-test', send))
    .resolves.toEqual({ code: 'http-error', detail: 'HTTP 503' })
})

it('separates a transport failure from a refused key', async () => {
  const send = sendStub(async () => reject())
  await expect(probeGatewayKey('https://gateway.example/v1', 'sk-test', send))
    .resolves.toEqual({ code: 'unreachable', detail: 'asynchronously closed' })
})
