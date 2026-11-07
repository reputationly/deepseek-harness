/** Product key gate: the only path into the workspace is a key the gateway accepts. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { WelcomeApi } from '../welcome-api.ts'

/**
 * Render the standalone key gate.
 * @param props.api - isolated preload API; no credential values are readable from the renderer.
 * @returns the key form with a single quit action.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mounted.current = true
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
    void api.analytics?.('auth_page_view', {})
    input.current?.focus()
    return () => { mounted.current = false }
  }, [api, m.welcomeTitle])

  async function saveKey(event: FormEvent) {
    event.preventDefault()
    if (busyRef.current) return
    void api.analytics?.('api_key_save_click', {})
    const value = draft.trim()
    if (!/^[\x21-\x7e]+$/.test(value)) {
      setError(value === '' ? m.welcomeKeyBlank : m.welcomeKeyInvalid)
      input.current?.focus()
      return
    }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api.saveApiKey(value)
      if (!mounted.current) return
      if (result.ok) setDraft('')
      else setError(result.reason === 'invalid' ? m.welcomeKeyRejected : m.welcomeKeyFailed)
    } catch {
      if (mounted.current) setError(m.welcomeKeyFailed)
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <>
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby="key-title">
      <img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />
      <form id="key-form" className="key-form" noValidate onSubmit={(event) => { void saveKey(event) }} aria-busy={busy}>
        <header className="key-heading"><h1 id="key-title">{m.welcomeKeyTitle}</h1><p id="key-description">{m.welcomeKeyDescription}</p></header>
        <div className="key-field">
          <label className="visually-hidden" htmlFor="key-input">{m.welcomeKeyPlaceholder}</label>
          <input ref={input} id="key-input" type="password" autoComplete="new-password" autoCapitalize="off" spellCheck={false} required
            aria-describedby="key-description key-error" aria-invalid={error !== ''} placeholder={m.welcomeKeyPlaceholder}
            value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setError('') }} />
          <p id="key-error" className="key-error" role="alert" hidden={error === ''}>{error}</p>
        </div>
      </form>
      <div id="key-actions" className="actions">
        <button id="save-key" className="primary" type="submit" form="key-form" disabled={busy || draft.trim() === ''}>{m.welcomeKeySave}</button>
        <button id="quit-app" className="secondary" type="button" disabled={busy} onClick={() => { api.quit() }}>{m.quit}</button>
      </div>
    </main>
  </>
}
