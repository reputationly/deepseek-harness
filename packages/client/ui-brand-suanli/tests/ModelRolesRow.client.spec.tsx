// @vitest-environment jsdom
/** The model role rows: one selector per role, an unavailable role, the chat hint, and the review switch. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { ModelRolesRow, type ModelRolesView } from '../src/client/ModelRolesRow.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: TranslateNS<'gatewayStatus'> = (key, params) => {
  const dictionary: Partial<Record<string, string>> = en
  const template = dictionary[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => JSON.stringify(params?.[name] ?? '').replace(/^"|"$/gu, ''))
}

const VIEW: ModelRolesView = {
  autoReview: true,
  roles: [
    { role: 'chat', candidates: [{ model: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash', reasoningEffort: 'off' }], selected: null, fallback: 'deepseek-v4-1-flash' },
    { role: 'vision', candidates: [{ model: 'qwen3.8-flash-fp8', label: 'Qwen 3.8 Flash', reasoningEffort: 'high' }], selected: null, fallback: 'qwen3.8-flash-fp8' },
    { role: 'image', candidates: [{ model: 'a', label: 'Image A' }, { model: 'b', label: 'Image B' }], selected: null, fallback: 'a' },
    { role: 'video', candidates: [{ model: 'v', label: 'Video V' }], selected: null, fallback: 'v' },
    { role: 'music', candidates: [{ model: 'm', label: 'Music M' }], selected: null, fallback: 'm' },
    { role: 'speech', candidates: [], selected: null, fallback: null },
  ],
}

function mount(view: ModelRolesView = VIEW) {
  const load = vi.fn(async () => view)
  const setAutoReview = vi.fn(async (enabled: boolean) => ({ ...view, autoReview: enabled }))
  render(<ModelRolesRow load={load} setAutoReview={setAutoReview} t={t} />)
  return { load, setAutoReview }
}

it('shows each fixed role with its model, thinking effort, and an unavailable role', async () => {
  mount()
  await screen.findByText('Image A')
  expect(screen.getByText('DeepSeek V4.1 Flash · Thinking: off')).toBeTruthy()
  expect(screen.getByText('Qwen 3.8 Flash · Thinking: high')).toBeTruthy()
  expect(screen.getByText(en['roles.unavailable'])).toBeTruthy()
  // Locked mode offers no role selector at all.
  expect(screen.queryByRole('button', { name: en['roles.image'] })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('turns the review off', async () => {
  const { setAutoReview } = mount()
  const toggle = await screen.findByRole('switch', { name: en['roles.review'] })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await vi.waitFor(() => { expect(setAutoReview).toHaveBeenCalledWith(false) })
})

it('says so when the roles cannot be read', async () => {
  render(<ModelRolesRow load={async () => { throw new Error('down') }}  setAutoReview={vi.fn()} t={t} />)
  await screen.findByText(en['roles.failed'])
})

it('ignores a load that settles after unmounting', async () => {
  let finish: (view: ModelRolesView) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const pending = () => new Promise<ModelRolesView>((resolve) => { finish = resolve })
  const first = render(<ModelRolesRow load={pending}  setAutoReview={vi.fn()} t={t} />)
  first.unmount()
  finish(VIEW)
  const failing = () => new Promise<ModelRolesView>((_resolve, fail) => { reject = fail })
  const second = render(<ModelRolesRow load={failing}  setAutoReview={vi.fn()} t={t} />)
  second.unmount()
  reject(new Error('late'))
  await Promise.resolve()
  expect(document.body.textContent).toBe('')
})

it('shows an empty value for a selected model that has no fallback', async () => {
  const view: ModelRolesView = { ...VIEW, roles: [{ role: 'video', candidates: [{ model: 'v', label: 'Video V' }], selected: null, fallback: null }] }
  render(<ModelRolesRow load={async () => view}  setAutoReview={vi.fn()} t={t} />)
  await screen.findByText(en['roles.unavailable'])
})
