/** Settings row that refreshes the model catalog from this deployment's gateway. */
import { useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CatalogSyncRow.module.css'

/** Why a refresh left the catalog as it was, in dictionary keys. */
const FAILURE_COPY = {
  'no-credential': 'catalog.no-credential',
  'unauthorized': 'catalog.unauthorized',
  'unreachable': 'catalog.unreachable',
  'empty-listing': 'catalog.empty',
} as const

/** Outcome a refresh reports, as far as this row renders it. */
export type CatalogSyncOutcome =
  | { readonly ok: true; readonly count: number; readonly changed: boolean }
  | { readonly ok: false; readonly reason: keyof typeof FAILURE_COPY }

/** Render inputs: the gateway operation and the plugin dictionary. */
export interface CatalogSyncRowProps {
  /** Refresh the catalog from the gateway. */
  readonly refresh: () => Promise<CatalogSyncOutcome>
  /** Translate one dictionary key of this plugin's namespace. */
  readonly t: TranslateNS<'gatewayStatus'>
}

/**
 * @param props - the refresh operation and locale seat.
 * @returns one settings row: what the control does, a button, and the last outcome.
 */
export function CatalogSyncRow({ refresh, t }: CatalogSyncRowProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<CatalogSyncOutcome | undefined>(undefined)

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      setOutcome(await refresh())
    } catch {
      setOutcome({ ok: false, reason: 'unreachable' })
    } finally {
      setBusy(false)
    }
  }

  const message = ((): string => {
    if (outcome === undefined) return t('catalog.description')
    if (!outcome.ok) return t(FAILURE_COPY[outcome.reason])
    return outcome.changed ? t('catalog.synced', { count: outcome.count }) : t('catalog.unchanged')
  })()

  return (
    <div className={css.row}>
      <div className={css.copy}>
        <p className={css.title}>{t('catalog.title')}</p>
        <p className={css.detail} role="status">{message}</p>
      </div>
      <button type="button" className={css.action} disabled={busy} onClick={() => { void run() }}>
        {busy ? t('catalog.syncing') : t('catalog.sync')}
      </button>
    </div>
  )
}
