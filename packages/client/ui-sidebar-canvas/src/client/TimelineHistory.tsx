/** Explicit history review keeps its baseline through concurrent edits and failed restoration. */
import { useState } from 'react'
import clsx from 'clsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TimelineRestoreMode } from '@deepseek-ai/dsh-canvas/client'
import type { TimelineActions, TimelineState } from './timeline-source.ts'
import type { NS } from './locales.ts'
import css from './TimelineEditor.module.css'

/** The revision and cursor action chosen before a request starts. */
export interface TimelineRestoreIntent { readonly revision: number; readonly baseRevision: number; readonly mode: TimelineRestoreMode }
type Props = PropsLocale<typeof NS> & {
  readonly initial: TimelineRestoreIntent
  readonly state: TimelineState
  readonly actions: Pick<TimelineActions, 'restore' | 'readHistory' | 'load'>
  readonly disabled: boolean
  readonly close: () => void
}
const modeLabels = { restore: 'editor.restore', undo: 'editor.undo', redo: 'editor.redo' } as const

/**
 * Review a saved revision without silently moving the request to a new live revision.
 * @param props - scoped data, initial intent, callbacks, and locale.
 * @returns the history dialog with an explicit apply-to-current action after a revision change.
 */
export function TimelineHistory({ initial, state, actions, disabled, close, t }: Props) {
  const [intent, setIntent] = useState(initial)
  const available = state.history?.some(entry => entry.revision === intent.revision) === true
  const current = state.document?.revision
  const changed = current !== intent.baseRevision
  const busy = state.working || state.loading
  return <Modal open title={t('editor.history')} closeLabel={t('editor.back')} onClose={close}>
    <div className={clsx(css.parameterForm)}>
      {current !== undefined && <p>{t('editor.revision', { revision: current })}</p>}
      <p className={css.hint}>{t('editor.historyHint')}</p>
      {state.history === undefined && <p role="alert">{t('editor.notice.history')}</p>}
      {state.notice !== undefined && <div role="alert">{t('editor.historyRetry')}{state.notice.message !== undefined && <details><summary>{t('editor.details')}</summary>{state.notice.message}</details>}</div>}
      {changed && <p role="alert">{t('editor.historyMoved')}</p>}
      {!available && state.history !== undefined && <p role="status">{t('editor.historyMissing')}</p>}
      <label className={css.field}><span>{t('editor.historyVersion')}</span>
        <select className={css.input} value={intent.revision} disabled={busy || disabled} onChange={(event) => {
          const entry = state.history?.find(entry => String(entry.revision) === event.target.value)
          if (entry !== undefined && current !== undefined) setIntent({ revision: entry.revision, baseRevision: current, mode: 'restore' })
        }}>
          {(state.history ?? []).map(entry => <option key={entry.revision} value={entry.revision}>{t('editor.historyEntry', { revision: entry.revision, count: entry.clips, duration: (entry.durationMs / 1000).toFixed(2) })}</option>)}
        </select>
      </label>
      <div className={css.actions}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void actions.load().then(() => actions.readHistory()) }}>{t('editor.reload')}</Button>
        {changed && <Button size="sm" disabled={disabled || busy || current === undefined} onClick={() => {
          if (current !== undefined) setIntent({ ...intent, baseRevision: current, mode: 'restore' })
        }}>{t('editor.reviewHistory')}</Button>}
        <Button size="sm" disabled={disabled || busy || changed || !available || intent.revision === current} onClick={() => {
          void actions.restore(intent.revision, intent.baseRevision, intent.mode).then((ok) => { if (ok) close() })
        }}>{t(modeLabels[intent.mode])}</Button>
      </div>
    </div>
  </Modal>
}
