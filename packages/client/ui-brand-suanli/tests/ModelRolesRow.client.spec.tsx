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
    { role: 'chat', candidates: [{ model: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash' }], selected: null, fallback: 'deepseek-v4-1-flash' },
    { role: 'vision', candidates: [{ model: 'qwen3.8-flash-fp8', label: 'Qwen 3.8 Flash' }], selected: null, fallback: 'qwen3.8-flash-fp8' },
    { role: 'image', candidates: [{ model: 'a', label: 'Image A' }, { model: 'b', label: 'Image B' }], selected: null, fallback: 'a' },
    { role: 'video', candidates: [{ model: 'v', label: 'Video V' }], selected: null, fallback: 'v' },
    { role: 'music', candidates: [{ model: 'm', label: 'Music M' }], selected: null, fallback: 'm' },
    { role: 'speech', candidates: [], selected: null, fallback: null },
  ],
}

function mount(view: ModelRolesView = VIEW) {
  const load = vi.fn(async () => view)
  const select = vi.fn(async (_role: string, model: string | null) => ({
    ...view, roles: view.roles.map(role => role.role === 'image' ? { ...role, selected: model } : role),
  }))
  const setAutoReview = vi.fn(async (enabled: boolean) => ({ ...view, autoReview: enabled }))
  render(<ModelRolesRow load={load} select={select} setAutoReview={setAutoReview} t={t} />)
  return { load, select, setAutoReview }
}

it('shows each role with its model, the chat hint, and an unavailable role', async () => {
  mount()
  await screen.findByText('Image A')
  expect(screen.getByText('DeepSeek V4.1 Flash')).toBeTruthy()
  expect(screen.getByText(en['roles.chat-hint'])).toBeTruthy()
  expect(screen.getByText(en['roles.unavailable'])).toBeTruthy()
  // Neither chat nor an empty role offers a selector, and no second key is asked for.
  expect(screen.queryByRole('button', { name: en['roles.chat'] })).toBeNull()
  expect(screen.queryByRole('button', { name: en['roles.speech'] })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('chooses a role model from the catalog candidates', async () => {
  const { select } = mount()
  fireEvent.click(await screen.findByRole('button', { name: en['roles.image'] }))
  fireEvent.click(await screen.findByText('Image B'))
  await vi.waitFor(() => { expect(select).toHaveBeenCalledWith('image', 'b') })
  await screen.findByText('Image B')
})

it('turns the review off', async () => {
  const { setAutoReview } = mount()
  const toggle = await screen.findByRole('switch', { name: en['roles.review'] })
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await vi.waitFor(() => { expect(setAutoReview).toHaveBeenCalledWith(false) })
})

it('says so when the roles cannot be read', async () => {
  render(<ModelRolesRow load={async () => { throw new Error('down') }} select={vi.fn()} setAutoReview={vi.fn()} t={t} />)
  await screen.findByText(en['roles.failed'])
})

it('closes the menu on a second press, falls back to the default, and reports a failed change', async () => {
  const view: ModelRolesView = { ...VIEW, roles: VIEW.roles.map(role => role.role === 'image' ? { ...role, fallback: 'gone' } : role) }
  const select = vi.fn(async () => { throw new Error('rejected') })
  render(<ModelRolesRow load={async () => view} select={select} setAutoReview={vi.fn()} t={t} />)
  const button = await screen.findByRole('button', { name: en['roles.image'] })
  expect(button.textContent).toContain('gone')
  fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(button)
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
  await vi.waitFor(() => { expect(button.getAttribute('aria-expanded')).toBe('false') })
  fireEvent.click(button)
  fireEvent.click(await screen.findByText(en['roles.default'].replace('{model}', 'gone')))
  await vi.waitFor(() => { expect(select).toHaveBeenCalledWith('image', null) })
  await screen.findByText(en['roles.failed'])
})

it('ignores a load that settles after unmounting', async () => {
  let finish: (view: ModelRolesView) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const pending = () => new Promise<ModelRolesView>((resolve) => { finish = resolve })
  const first = render(<ModelRolesRow load={pending} select={vi.fn()} setAutoReview={vi.fn()} t={t} />)
  first.unmount()
  finish(VIEW)
  const failing = () => new Promise<ModelRolesView>((_resolve, fail) => { reject = fail })
  const second = render(<ModelRolesRow load={failing} select={vi.fn()} setAutoReview={vi.fn()} t={t} />)
  second.unmount()
  reject(new Error('late'))
  await Promise.resolve()
  expect(document.body.textContent).toBe('')
})

it('shows an empty value for a selected model that has no fallback', async () => {
  const view: ModelRolesView = { ...VIEW, roles: [{ role: 'video', candidates: [{ model: 'v', label: 'Video V' }], selected: null, fallback: null }] }
  render(<ModelRolesRow load={async () => view} select={vi.fn()} setAutoReview={vi.fn()} t={t} />)
  expect((await screen.findByRole('button', { name: en['roles.video'] })).textContent).toContain(en['roles.unavailable'])
})
