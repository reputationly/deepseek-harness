// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { WelcomeSaveResult } from '../src/welcome-api.ts'

const html = readFileSync(join(import.meta.dirname, '../renderer/welcome.html'), 'utf8')
afterEach(cleanup)

function mount(language = 'zh-CN', save: (value: string) => Promise<WelcomeSaveResult> = async () => ({ ok: true })) {
  cleanup()
  const quit = vi.fn()
  const api = {
    quit,
    analytics: vi.fn(async (_event: string, _attributes: object) => {}),
    ...resolveDesktopLocale(language),
    saveApiKey: vi.fn(save),
  }
  const mounted = render(<Welcome api={api as never} />)
  const input = document.querySelector<HTMLInputElement>('input')!
  const button = (id: string) => document.querySelector<HTMLButtonElement>(id)!
  const enterKey = (value: string) => { fireEvent.change(input, { target: { value } }) }
  const submit = () => { fireEvent.submit(document.querySelector('form')!) }
  const error = () => document.querySelector('#key-error')?.textContent ?? ''
  return { api, input, button, enterKey, submit, error, unmount: mounted.unmount }
}

describe('product key gate', () => {
  it.each(['zh-CN', 'en'])('renders the %s key gate as the only entry', (language) => {
    const view = mount(language)
    const m = resolveDesktopLocale(language).messages
    expect(document.documentElement.lang).toBe(language)
    expect(document.title).toBe(m.welcomeTitle)
    expect(document.querySelector('img')!.getAttribute('src')).toBe('assets/welcome-brand.svg')
    expect(document.querySelector('#key-title')!.textContent).toBe(m.welcomeKeyTitle)
    expect(document.querySelector('#key-description')!.textContent).toBe(m.welcomeKeyDescription)
    expect(view.input.type).toBe('password')
    expect(view.button('#save-key').textContent).toBe(m.welcomeKeySave)
    expect(view.button('#save-key').disabled).toBe(true)
    expect(view.button('#quit-app').textContent).toBe(m.quit)
    for (const removed of ['#sign-in', '#api-key', '#skip-key', '#back-to-login', '#entry-actions', '#auth-page']) {
      expect(document.querySelector(removed)).toBeNull()
    }
  })

  it('submits one trimmed key, blocks competing submits, and clears the draft on success', async () => {
    let resolve: (value: WelcomeSaveResult) => void = () => {}
    const view = mount('en', () => new Promise<WelcomeSaveResult>((done) => { resolve = done }))
    view.enterKey('  sk-live-key  ')
    expect(view.button('#save-key').disabled).toBe(false)
    view.submit()
    view.submit()
    expect(view.api.saveApiKey).toHaveBeenCalledTimes(1)
    expect(view.api.saveApiKey).toHaveBeenCalledWith('sk-live-key')
    expect(view.button('#save-key').disabled).toBe(true)
    expect(view.input.disabled).toBe(true)
    resolve({ ok: true })
    await vi.waitFor(() => { expect(view.input.value).toBe('') })
    expect(view.error()).toBe('')
  })

  it('keeps the draft and names a rejected key', async () => {
    const view = mount('en', async () => ({ ok: false, reason: 'invalid' }))
    const m = resolveDesktopLocale('en').messages
    view.enterKey('sk-wrong')
    view.submit()
    await vi.waitFor(() => { expect(view.error()).toBe(m.welcomeKeyRejected) })
    expect(view.input.value).toBe('sk-wrong')
    expect(view.input.disabled).toBe(false)
  })

  it('separates an unreachable service from a rejected key', async () => {
    const view = mount('en', async () => ({ ok: false, reason: 'unreachable' }))
    const m = resolveDesktopLocale('en').messages
    view.enterKey('sk-any')
    view.submit()
    await vi.waitFor(() => { expect(view.error()).toBe(m.welcomeKeyFailed) })
    expect(view.error()).not.toBe(m.welcomeKeyRejected)
  })

  it('rejects a blank or malformed key without calling the backend', async () => {
    const view = mount('en')
    const m = resolveDesktopLocale('en').messages
    view.enterKey('bad key')
    view.submit()
    expect(view.error()).toBe(m.welcomeKeyInvalid)
    view.enterKey('')
    view.submit()
    expect(view.error()).toBe(m.welcomeKeyBlank)
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
  })

  it('quits from the only secondary action and reports the page view', () => {
    const view = mount('en')
    expect(view.api.analytics).toHaveBeenCalledWith('auth_page_view', {})
    fireEvent.click(view.button('#quit-app'))
    expect(view.api.quit).toHaveBeenCalledTimes(1)
  })

  it('renders inside the shipped welcome document without a network-capable surface', () => {
    expect(html).toContain('lib/welcome/welcome.js')
    expect(html).not.toMatch(/https?:\/\//u)
    expect(document.querySelector('script[src^="http"]')).toBeNull()
    expect(document.querySelectorAll('iframe')).toHaveLength(0)
  })
})
