/** Local audio drafts are owned by the application so version changes never discard them. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNodeId, CanvasScope, NodeVersion, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { LocalMediaEditResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasInjected } from './face.ts'
import type { NS } from './locales.ts'
import css from './AudioEditor.module.css'

/** Unparsed text is retained while users type and switch between history versions. */
export interface AudioEditDraft {
  readonly inSeconds: string
  readonly outSeconds: string
  readonly volume: string
  readonly fadeInSeconds: string
  readonly fadeOutSeconds: string
}

/** A blank end uses the measured source duration; gain is linear. */
export const emptyAudioEditDraft: AudioEditDraft = { inSeconds: '0', outSeconds: '', volume: '1', fadeInSeconds: '0', fadeOutSeconds: '0' }

interface Props extends PropsLocale<typeof NS> {
  readonly node: CanvasNodeId
  readonly selected: VersionId | undefined
  readonly version: NodeVersion | undefined
  readonly scope: CanvasScope
  readonly enabled: boolean
  readonly drafts: ReadonlyMap<VersionId, AudioEditDraft>
  readonly change: (version: VersionId, draft: AudioEditDraft) => void
  readonly saved: (source: VersionId, result: LocalMediaEditResult) => void
  readonly preview: (version: VersionId) => void
  readonly reload: () => Promise<void>
  readonly edit: NonNullable<CanvasInjected['editMedia']>
}

const fields = [['inSeconds', 'audio.trimStart'], ['outSeconds', 'audio.trimEnd'], ['volume', 'audio.gain'],
  ['fadeInSeconds', 'audio.fadeIn'], ['fadeOutSeconds', 'audio.fadeOut']] as const

/**
 * Render local trim, gain, and fades for an exact source. Saving never changes preview or adoption;
 * the user can explicitly audition the completed candidate. A rejected request retains every draft.
 * @param props - captured source, retained drafts, shared local edit action, and locale.
 * @returns local audio controls and visible processing, recovery, or candidate state.
 */
export function AudioLocalControls({ node, selected, version, scope, enabled, drafts, change, saved, preview, reload, edit, t }: Props) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ readonly key: 'audio.localInvalid' | 'audio.localFailed' | 'audio.localUnknown' | 'audio.localUnavailable' | 'audio.localRefreshFailed'; readonly message?: string }>()
  const [result, setResult] = useState<LocalMediaEditResult>()
  const draft = selected === undefined ? emptyAudioEditDraft : drafts.get(selected) ?? emptyAudioEditDraft
  const save = async (): Promise<void> => {
    if (!enabled || version?.path === undefined || selected === undefined) return
    const inMs = Math.round(Number(draft.inSeconds) * 1000), volume = Number(draft.volume)
    const fadeInMs = Math.round(Number(draft.fadeInSeconds) * 1000), fadeOutMs = Math.round(Number(draft.fadeOutSeconds) * 1000)
    const outMs = draft.outSeconds.trim() === '' ? undefined : Math.round(Number(draft.outSeconds) * 1000)
    if ([draft.inSeconds, draft.volume, draft.fadeInSeconds, draft.fadeOutSeconds].some(value => value.trim() === '')
      || ![inMs, volume, fadeInMs, fadeOutMs].every(Number.isFinite) || inMs < 0 || volume < 0 || volume > 4
      || fadeInMs < 0 || fadeOutMs < 0 || outMs !== undefined && (!Number.isFinite(outMs) || outMs <= inMs)) {
      setNotice({ key: 'audio.localInvalid' }); return
    }
    const source = selected
    setBusy(true); setNotice(undefined); setResult(undefined)
    let acknowledged = false
    try {
      const reply = await edit({ scope, node, version: source, operation: 'audio_edit', inMs, volume, fadeInMs, fadeOutMs,
        ...outMs === undefined ? {} : { outMs } })
      if (reply === undefined) setNotice({ key: 'audio.localUnavailable' })
      else if (!reply.ok) setNotice({ key: reply.error.code === 'media/edit' ? 'audio.localFailed' : 'audio.localUnknown', message: reply.error.code === 'media/edit' && reply.error.details.path !== undefined
        ? t('video.retainedFile', { message: reply.error.message, path: reply.error.details.path }) : reply.error.message })
      else { acknowledged = true; saved(source, reply.value); setResult(reply.value); await reload() }
    } catch (error: unknown) { setNotice({ key: acknowledged ? 'audio.localRefreshFailed' : 'audio.localUnknown', ...error instanceof Error ? { message: error.message } : {} }) }
    finally { setBusy(false) }
  }
  return <section className={css.local} aria-label={t('audio.localEdit')}>
    <h3 className={css.sectionTitle}>{t('audio.localEdit')}</h3>
    <p className={css.hint}>{t('audio.localHint')}</p>
    <fieldset className={css.localFields} disabled={!enabled || busy || version?.path === undefined}>
      {fields.map(([field, label]) => <label key={field} className={css.field}><span>{t(label)}</span>
        <input className={css.select} type="number" min="0" max={field === 'volume' ? 4 : undefined} step="any"
          placeholder={field === 'outSeconds' ? t('audio.sourceEnd') : undefined} value={draft[field]} onChange={(event) => {
            if (selected !== undefined) change(selected, { ...draft, [field]: event.target.value })
          }} /></label>)}
    </fieldset>
    <Button size="sm" variant="outline" aria-busy={busy} disabled={!enabled || busy || version?.path === undefined} onClick={() => { void save() }}>{t('audio.saveLocal')}</Button>
    {busy && <p className={css.message} role="status">{t('audio.localSaving')}</p>}
    {notice !== undefined && <p className={css.message} role="alert">{t(notice.key, { message: notice.message ?? '' })}</p>}
    {result !== undefined && <div className={css.local} role="status"><p className={css.hint}>{t('audio.localSaved')}</p>
      <Button size="sm" variant="outline" disabled={!enabled} onClick={() => { preview(result.version) }}>{t('audio.previewLocal')}</Button></div>}
  </section>
}
