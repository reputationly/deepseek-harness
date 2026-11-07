import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandGateway, gatewayProfilePatch, writeGatewayProfile } from '../src/brand-gateway.ts'
import { probeGatewayKey } from '../src/gateway-probe.ts'

const GATEWAY = {
  baseURL: 'https://gateway.example/v1',
  apiKeyEnv: 'EXAMPLE_API_KEY',
  defaultModel: 'model-a',
  models: [{ id: 'model-a', contextWindow: 1000 }, { id: 'model-b' }],
}

afterEach(() => { vi.unstubAllEnvs() })

describe('gateway key probe', () => {
  const call = (status: number) => vi.fn<typeof fetch>(async () => new Response('{}', { status }))

  it('accepts a listing response and sends both authentication headers', async () => {
    const send = call(200)
    expect(await probeGatewayKey('https://gateway.example/v1/', 'sk-live', send)).toBe('ok')
    const [url, init] = send.mock.calls[0]!
    expect(url).toBe('https://gateway.example/v1/models')
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-live')
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-live')
  })

  it.each([401, 403])('reports %d as a rejected key', async (status) => {
    expect(await probeGatewayKey('https://gateway.example/v1', 'sk-wrong', call(status))).toBe('invalid')
  })

  it.each([500, 404, 302])('reports %d as unreachable rather than invalid', async (status) => {
    expect(await probeGatewayKey('https://gateway.example/v1', 'sk-any', call(status))).toBe('unreachable')
  })

  it('reports a transport failure as unreachable', async () => {
    const send = vi.fn<typeof fetch>(async () => { throw new Error('offline') })
    expect(await probeGatewayKey('https://gateway.example/v1', 'sk-any', send)).toBe('unreachable')
  })
})

describe('brand gateway configuration', () => {
  it('returns undefined when the build inlined no gateway', () => {
    vi.stubEnv('DSH_BRAND_GATEWAY', '')
    expect(brandGateway()).toBeUndefined()
  })

  it('parses the inlined gateway and keeps the catalog', () => {
    vi.stubEnv('DSH_BRAND_GATEWAY', JSON.stringify(GATEWAY))
    expect(brandGateway()).toEqual(GATEWAY)
  })

  it('rejects a default model outside the catalog', () => {
    vi.stubEnv('DSH_BRAND_GATEWAY', JSON.stringify({ ...GATEWAY, defaultModel: 'model-z' }))
    expect(() => brandGateway()).toThrow(/defaultModel/u)
  })

  it('rejects a non-URL endpoint and an empty catalog', () => {
    vi.stubEnv('DSH_BRAND_GATEWAY', JSON.stringify({ ...GATEWAY, baseURL: 'not a url' }))
    expect(() => brandGateway()).toThrow(/baseURL/u)
    vi.stubEnv('DSH_BRAND_GATEWAY', JSON.stringify({ ...GATEWAY, models: [] }))
    expect(() => brandGateway()).toThrow(/models/u)
  })

  it('writes the profile patch that replaces the provider endpoint, catalog, and default model', () => {
    const patch = gatewayProfilePatch(GATEWAY)
    expect(patch).toContain('- id: agent-default-model')
    expect(patch).toContain('    model: "model-a"')
    expect(patch).toContain('- id: llm-deepseek')
    expect(patch).toContain('    baseURL: "https://gateway.example/v1"')
    expect(patch).toContain('    apiKeyEnv: "EXAMPLE_API_KEY"')
    expect(patch).toContain('      - id: "model-a"\n        contextWindow: 1000')
    expect(patch).toContain('      - id: "model-b"')
  })

  it('rewrites the profile patch file and leaves other profiles untouched', () => {
    vi.stubEnv('DSH_BRAND_GATEWAY', JSON.stringify(GATEWAY))
    const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-'))
    try {
      writeGatewayProfile(root)
      expect(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toBe(gatewayProfilePatch(GATEWAY))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes nothing when the build inlined no gateway', () => {
    vi.stubEnv('DSH_BRAND_GATEWAY', '')
    const root = mkdtempSync(join(tmpdir(), 'dsh-gateway-'))
    try {
      writeGatewayProfile(root)
      expect(() => readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
