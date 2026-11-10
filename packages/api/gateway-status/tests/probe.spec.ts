// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { probeGatewayKey } from '../src/probe.ts'

function answer(status: number, body = ''): Response {
  return new Response(body, { status })
}

const reject = (): never => { throw new Error('asynchronously closed') }

it('reports an answered key as connected and asks the listing endpoint with the key', async () => {
  const send = vi.fn(async () => answer(200, '{"data":[]}'))
  await expect(probeGatewayKey('https://gateway.example/v1/', 'sk-test', send as unknown as typeof fetch))
    .resolves.toEqual({ code: 'connected' })
  const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://gateway.example/v1/models')
  expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
  expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test')
})

it.each([401, 403])('reports HTTP %i as a refused key', async (status) => {
  const send = vi.fn(async () => answer(status))
  await expect(probeGatewayKey('https://gateway.example/v1', 'sk-test', send as unknown as typeof fetch))
    .resolves.toEqual({ code: 'key-rejected' })
})

it('carries the gateway status of any other refusal', async () => {
  const send = vi.fn(async () => answer(503))
  await expect(probeGatewayKey('https://gateway.example/v1', 'sk-test', send as unknown as typeof fetch))
    .resolves.toEqual({ code: 'http-error', detail: 'HTTP 503' })
})

it('separates a transport failure from a refused key', async () => {
  const send = vi.fn(async () => reject())
  await expect(probeGatewayKey('https://gateway.example/v1', 'sk-test', send as unknown as typeof fetch))
    .resolves.toEqual({ code: 'unreachable', detail: 'asynchronously closed' })
})
