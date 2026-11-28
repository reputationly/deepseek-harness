/** Locked gateway-key card for the Suanli model settings page. */
import { useEffect, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GatewayStatusKey } from './locales.ts'
import css from './LockedKeyCard.module.css'

type CheckResult = {
  readonly ok: boolean
  readonly reason?: 'missing-key' | 'unauthorized' | 'unreachable' | 'invalid-catalog' | 'empty-catalog' | 'write-failed'
  readonly saved?: boolean
}

export interface LockedKeyCardInjected {
  readonly keyConfigured: boolean
  readonly test: (key: string) => Promise<CheckResult>
  readonly save: (key: string) => Promise<CheckResult>
}

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'testing' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'tested' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'failed'; readonly reason: NonNullable<CheckResult['reason']> }

function errorKey(reason: NonNullable<CheckResult['reason']>): GatewayStatusKey {
  switch (reason) {
    case 'missing-key': return 'locked.missing-key'
    case 'unauthorized': return 'locked.unauthorized'
    case 'invalid-catalog': return 'locked.invalid-catalog'
    case 'empty-catalog': return 'locked.empty-catalog'
    case 'write-failed': return 'locked.write-failed'
    default: return 'locked.unreachable'
  }
}

export function LockedKeyCard(props: LockedKeyCardInjected & { t: TranslateNS<'gatewayStatus'> }): ReactNode {
  const [key, setKey] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const busy = status.kind === 'testing' || status.kind === 'saving'
  const usable = key.trim() !== '' || props.keyConfigured
  const dirty = key.trim() !== ''
  useEffect(() => {
    if (!dirty) return undefined
    const hold = (event: Event): void => { event.preventDefault() }
    window.addEventListener('settings-close-request', hold)
    return () => { window.removeEventListener('settings-close-request', hold) }
  }, [dirty])

  const run = async (save: boolean): Promise<void> => {
    setStatus({ kind: save ? 'saving' : 'testing' })
    try {
      const result = await (save ? props.save(key.trim()) : props.test(key.trim()))
      if (!result.ok) setStatus({ kind: 'failed', reason: result.reason ?? 'unreachable' })
      else {
        setStatus({ kind: save ? 'saved' : 'tested' })
        if (save) setKey('')
      }
    } catch {
      setStatus({ kind: 'failed', reason: 'unreachable' })
    }
  }

  return (
    <section className={css.card} aria-label={props.t('locked.title')}>
      <div className={css.copy}>
        <p className={css.title}>{props.t('locked.title')}</p>
        <p className={css.detail}>{props.t('locked.description')}</p>
      </div>
      <label className={css.field}>
        <span className={css.label}>{props.t('locked.key')}</span>
        <input
          className={css.input}
          type="password"
          value={key}
          disabled={busy}
          autoComplete="off"
          placeholder={props.keyConfigured ? props.t('locked.saved-placeholder') : 'sk-...'}
          onChange={(event) => { setKey(event.target.value); if (!busy) setStatus({ kind: 'idle' }) }}
        />
      </label>
      {dirty ? <p className={css.unsaved}>{props.t('locked.unsaved')}</p> : null}
      {status.kind === 'tested' ? <p className={css.success} role="status">{props.t('locked.tested')}</p> : null}
      {status.kind === 'saved' ? <p className={css.success} role="status">{props.t('locked.saved')}</p> : null}
      {status.kind === 'failed' ? <p className={css.error} role="alert">{props.t(errorKey(status.reason))}</p> : null}
      <div className={css.actions}>
        <button type="button" className={css.secondary} disabled={busy || !usable} onClick={() => { void run(false) }}>
          {status.kind === 'testing' ? props.t('locked.testing') : props.t('locked.test')}
        </button>
        <button type="button" className={css.primary} disabled={busy || !usable} onClick={() => { void run(true) }}>
          {status.kind === 'saving' ? props.t('locked.saving') : props.t('locked.save')}
        </button>
      </div>
    </section>
  )
}
