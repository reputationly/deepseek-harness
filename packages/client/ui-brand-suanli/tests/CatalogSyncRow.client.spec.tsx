// @vitest-environment jsdom
/** The catalog-sync row: one button, one outcome line, and the copy each outcome shows. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CatalogSyncRow, type CatalogSyncOutcome } from '../src/client/CatalogSyncRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: TranslateNS<'gatewayStatus'> = (key, params) => {
  const dictionary: Partial<Record<string, string>> = en
  const template = dictionary[key] ?? key
  const render = (name: string): string => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  }
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => render(name))
}

function mount(outcome: CatalogSyncOutcome) {
  const refresh = vi.fn(async () => outcome)
  render(<CatalogSyncRow refresh={refresh} t={t} />)
  return { refresh }
}

it('reports how many models the sync put in effect', async () => {
  const { refresh } = mount({ ok: true, count: 21, changed: true })
  fireEvent.click(screen.getByRole('button', { name: en['catalog.sync'] }))
  await screen.findByText('Synced 21 models')
  expect(refresh).toHaveBeenCalledOnce()
})

it('says the catalog was already current', async () => {
  mount({ ok: true, count: 21, changed: false })
  fireEvent.click(screen.getByRole('button', { name: en['catalog.sync'] }))
  await screen.findByText(en['catalog.unchanged'])
})

it.each([
  ['no-credential', 'catalog.no-credential'],
  ['unauthorized', 'catalog.unauthorized'],
  ['unreachable', 'catalog.unreachable'],
  ['empty-listing', 'catalog.empty'],
] as const)('explains a %s outcome', async (reason, key) => {
  mount({ ok: false, reason })
  fireEvent.click(screen.getByRole('button', { name: en['catalog.sync'] }))
  await screen.findByText(en[key])
})

it('reports an unreachable gateway when the call itself fails', async () => {
  const refresh = vi.fn(async (): Promise<CatalogSyncOutcome> => { throw new Error('offline') })
  render(<CatalogSyncRow refresh={refresh} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en['catalog.sync'] }))
  await screen.findByText(en['catalog.unreachable'])
})
