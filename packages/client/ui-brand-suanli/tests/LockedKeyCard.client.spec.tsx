// @vitest-environment jsdom
/** The locked key card: test never writes, save validates then writes, and dirty input warns inline. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { LockedKeyCard } from '../src/client/LockedKeyCard.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: TranslateNS<'gatewayStatus'> = (key, params) => {
  const template = (en as Partial<Record<string, string>>)[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))
}

function mount(options: { keyConfigured?: boolean; test?: () => Promise<{ ok: boolean; reason?: 'unauthorized' }>; save?: () => Promise<{ ok: boolean; saved?: boolean }> } = {}) {
  const test = vi.fn(options.test ?? (async () => ({ ok: true })))
  const save = vi.fn(options.save ?? (async () => ({ ok: true, saved: true })))
  render(<LockedKeyCard keyConfigured={options.keyConfigured ?? false} test={test} save={save} t={t} />)
  return { test, save }
}

it('tests a typed key without saving it and warns that the change is unsaved', async () => {
  const { test, save } = mount()
  fireEvent.change(screen.getByLabelText(en['locked.key']), { target: { value: 'sk-new' } })
  expect(screen.getByText(en['locked.unsaved'])).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en['locked.test'] }))
  await screen.findByText(en['locked.tested'])
  expect(test).toHaveBeenCalledWith('sk-new')
  expect(save).not.toHaveBeenCalled()
})

it('saves through the save path and clears the draft', async () => {
  const { save } = mount()
  const input = screen.getByLabelText(en['locked.key'])
  fireEvent.change(input, { target: { value: 'sk-new' } })
  fireEvent.click(screen.getByRole('button', { name: en['locked.save'] }))
  await screen.findByText(en['locked.saved'])
  expect(save).toHaveBeenCalledWith('sk-new')
  expect((input as HTMLInputElement).value).toBe('')
  expect(screen.queryByText(en['locked.unsaved'])).toBeNull()
})

it('uses the already saved key when the draft is empty and names rejection', async () => {
  mount({ keyConfigured: true, test: async () => ({ ok: false, reason: 'unauthorized' }) })
  fireEvent.click(screen.getByRole('button', { name: en['locked.test'] }))
  await screen.findByText(en['locked.unauthorized'])
})

it('does not offer a custom model or configuration editor', () => {
  mount({ keyConfigured: true })
  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
})
