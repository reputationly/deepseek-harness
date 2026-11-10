// @vitest-environment jsdom
/** Footer connection light: every state's label and failure reason, and the retry gesture. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GatewayStatus } from '@deepseek-ai/dsh-api-gateway-status/types'
import { ConnectionPill, type ConnectionPillProps } from '../src/client/ConnectionPill.tsx'
import { en, type GatewayStatusKey } from '../src/client/locales.ts'

afterEach(cleanup)

/** The plugin's `t` seat, with the `{detail}` interpolation the pill relies on. */
type PillText = (key: GatewayStatusKey, params?: Record<string, string>) => string
const t: PillText = (key, params) =>
  (en[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) => params?.[name] ?? '')

function mount(initial: GatewayStatus, ...later: GatewayStatus[]) {
  const read = vi.fn(async () => initial)
  const refresh = vi.fn(async () => later.shift() ?? initial)
  const props = { wide: true, read, refresh, t } as unknown as ConnectionPillProps
  render(<ConnectionPill {...props} />)
  return { read, refresh }
}

it('shows the connected state for an answered gateway', async () => {
  mount({ state: 'connected', code: 'connected' })
  const pill = await screen.findByRole('button', { name: en.connected })
  expect(pill.textContent).toBe(en.connected)
  expect(pill.getAttribute('title')).toBe(en.connected)
})

it.each([
  { code: 'no-key' as const, reason: en['reason.no-key'] },
  { code: 'key-rejected' as const, reason: en['reason.key-rejected'] },
])('explains a %s failure in the tooltip', async ({ code, reason }) => {
  mount({ state: 'disconnected', code })
  const pill = await screen.findByRole('button', { name: reason })
  expect(pill.textContent).toBe(en.disconnected)
  expect(pill.getAttribute('title')).toBe(reason)
})

it('tells a transport failure apart from a refused key and carries the detail', async () => {
  mount({ state: 'disconnected', code: 'unreachable', detail: 'fetch failed' })
  expect(await screen.findByRole('button', { name: 'Cannot reach the gateway: fetch failed' })).toBeTruthy()
})

it('carries the gateway status text of another refusal', async () => {
  mount({ state: 'disconnected', code: 'http-error', detail: 'HTTP 503' })
  expect(await screen.findByRole('button', { name: 'The gateway answered HTTP 503.' })).toBeTruthy()
})

it('re-probes when the light is pressed', async () => {
  // Mount probes once; the pressed light probes again and settles on the recovered key.
  const { refresh } = mount({ state: 'disconnected', code: 'key-rejected' }, { state: 'disconnected', code: 'key-rejected' },
    { state: 'connected', code: 'connected' })
  fireEvent.click(await screen.findByRole('button', { name: en['reason.key-rejected'] }))
  // Once for the mount probe and once for the press.
  expect(refresh).toHaveBeenCalledTimes(2)
  await screen.findByRole('button', { name: en.connected })
})

it('renders the dot alone in the collapsed rail', async () => {
  const status = { state: 'connected', code: 'connected' } as const
  const props = { wide: false, read: vi.fn(async () => status), refresh: vi.fn(async () => status), t } as unknown as ConnectionPillProps
  render(<ConnectionPill {...props} />)
  const pill = await screen.findByRole('button', { name: en.connected })
  expect(pill.textContent).toBe('')
})
