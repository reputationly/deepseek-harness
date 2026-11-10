// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { GatewayStatusCache } from '../src/status.ts'
import type { ProbeResult } from '../src/probe.ts'

function deferred(): { promise: Promise<ProbeResult>; settle: (outcome: ProbeResult) => void } {
  let settle: (outcome: ProbeResult) => void = () => {}
  const promise = new Promise<ProbeResult>((resolve) => { settle = resolve })
  return { promise, settle }
}

it('reports checking until the first probe settles, then the stamped observation', async () => {
  const pending = deferred()
  const cache = new GatewayStatusCache(() => pending.promise, () => 1_700_000_000_000)
  expect(cache.current()).toEqual({ state: 'checking', code: 'unreachable' })
  const run = cache.refresh()
  expect(cache.current().state).toBe('checking')
  pending.settle({ code: 'connected' })
  await expect(run).resolves.toEqual({ state: 'connected', code: 'connected', checkedAt: 1_700_000_000_000 })
  expect(cache.current()).toEqual({ state: 'connected', code: 'connected', checkedAt: 1_700_000_000_000 })
})

it('carries the failure code and detail into the observation', async () => {
  const cache = new GatewayStatusCache(async () => ({ code: 'key-rejected' }), () => 7)
  await expect(cache.refresh()).resolves.toEqual({ state: 'disconnected', code: 'key-rejected', checkedAt: 7 })
})

it('shares one probe between concurrent readers', async () => {
  const pending = deferred()
  const probe = vi.fn(() => pending.promise)
  const cache = new GatewayStatusCache(probe, () => 1)
  const first = cache.refresh()
  const second = cache.refresh()
  expect(probe).toHaveBeenCalledTimes(1)
  pending.settle({ code: 'connected' })
  await expect(Promise.all([first, second])).resolves.toEqual([
    { state: 'connected', code: 'connected', checkedAt: 1 },
    { state: 'connected', code: 'connected', checkedAt: 1 },
  ])
  // A settled probe frees the next refresh to ask again.
  await cache.refresh()
  expect(probe).toHaveBeenCalledTimes(2)
})

it('reports a throwing probe instead of leaving the light checking', async () => {
  const cache = new GatewayStatusCache(async () => { throw new Error('credential store unreadable') }, () => 3)
  await expect(cache.refresh()).resolves.toEqual({
    state: 'disconnected', code: 'unreachable', detail: 'credential store unreadable', checkedAt: 3,
  })
})
