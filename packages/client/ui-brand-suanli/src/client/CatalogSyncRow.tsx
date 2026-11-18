/** Settings row that refreshes the model catalog from this deployment's gateway. */
import { useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GatewayStatusKey } from './locales.ts'
import css from './CatalogSyncRow.module.css'

/** Why a refresh left the catalog as it was, in dictionary keys. */
const FAILURE_COPY = {
  'no-credential': 'catalog.no-credential',
  'unauthorized': 'catalog.unauthorized',
  'unreachable': 'catalog.unreachable',
  'empty-listing': 'catalog.empty',
} as const

/** One capability class the gateway declared, in the fields this row renders. */
export interface CatalogClass {
  readonly capability: string
  readonly models: readonly string[]
}

/** Outcome a refresh reports, as far as this row renders it. */
export type CatalogSyncOutcome =
  | {
    readonly ok: true
    readonly count: number
    readonly changed: boolean
    /** Classes the gateway declared, empty when it declared none. */
    readonly classes: readonly CatalogClass[]
  }
  | { readonly ok: false; readonly reason: keyof typeof FAILURE_COPY }

/** Dictionary key of each capability class the gateway can declare. */
function classKeys(): Readonly<Record<string, GatewayStatusKey>> {
  return {
    'chat': 'class.chat',
    'vision.image': 'class.vision-image',
    'vision.video': 'class.vision-video',
    'image.generate': 'class.image-generate',
    'image.edit': 'class.image-edit',
    'video.generate': 'class.video-generate',
    'video.first-last-frame': 'class.video-first-last-frame',
    'video.reference': 'class.video-reference',
    'music.generate': 'class.music-generate',
    'speech.generate': 'class.speech-generate',
    'other': 'class.other',
  }
}

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

  const capabilityRows = ((): readonly { key: string; label: string; count: number }[] => {
    if (outcome === undefined || !outcome.ok || outcome.classes.length === 0) return []
    const keys = classKeys()
    return outcome.classes.map(entry => ({
      key: entry.capability,
      label: t(keys[entry.capability] ?? 'class.other'),
      count: entry.models.length,
    }))
  })()

  const message = ((): string => {
    if (outcome === undefined) return t('catalog.description')
    if (!outcome.ok) return t(FAILURE_COPY[outcome.reason])
    return outcome.changed ? t('catalog.synced', { count: outcome.count }) : t('catalog.unchanged')
  })()

  return (
    <>
      <div className={css.row}>
        <div className={css.copy}>
          <p className={css.title}>{t('catalog.title')}</p>
          <p className={css.detail} role="status">{message}</p>
        </div>
        <button type="button" className={css.action} disabled={busy} onClick={() => { void run() }}>
          {busy ? t('catalog.syncing') : t('catalog.sync')}
        </button>
      </div>
      {capabilityRows.length === 0 ? null : (
        <div className={css.classes}>
          <p className={css.classesTitle}>{t('catalog.capability-title')}</p>
          <ul className={css.classList}>
            {capabilityRows.map(row => (
              <li key={row.key} className={css.classItem}>{row.label}<span className={css.classCount}>{row.count}</span></li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
