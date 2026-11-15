/** Local audio enters the same candidate history as generated music and speech. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNodeId, CanvasScope } from '@deepseek-ai/dsh-canvas/client'
import type { CanvasBodyProps } from './CanvasBody.tsx'
import type { CanvasInjected } from './face.ts'
import css from './AudioEditor.module.css'

/** Captured upload target and the owner's candidate-refresh path. */
export interface AudioImportControlsProps {
  readonly node: CanvasNodeId
  readonly scope: CanvasScope
  readonly enabled: boolean
  readonly upload: NonNullable<CanvasInjected['importAudio']>
  readonly reload: () => Promise<void>
  readonly t: CanvasBodyProps['t']
}

/**
 * Upload an initial or replacement audio candidate without adopting or discarding drafts.
 * @param props - captured target, scoped upload, availability, and localized feedback.
 * @returns the native file picker action with visible progress and recovery status.
 */
export function AudioImportControls({ node, scope, enabled, upload, reload, t }: AudioImportControlsProps) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ readonly key: 'audio.localUnavailable' | 'audio.localFailed' | 'audio.localUnknown' | 'audio.localRefreshFailed' | 'audio.uploaded'; readonly message?: string }>()
  const picker = useRef<HTMLInputElement>(null)
  const pending = useRef<AbortController>()
  const key = `${scope.directory}/${scope.episode}/${node}`
  const current = useRef<string | undefined>(enabled ? key : undefined)
  current.current = enabled ? key : undefined
  useEffect(() => {
    current.current = enabled ? key : undefined
    setBusy(false); setNotice(undefined)
    return () => { current.current = undefined; pending.current?.abort() }
  }, [key, enabled])
  const save = async (file: File): Promise<void> => {
    if (!enabled || busy) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true); setNotice(undefined)
    let acknowledged = false
    try {
      const reply = await upload(node, scope, file, controller.signal)
      if (current.current !== key) return
      if (reply === undefined) setNotice({ key: 'audio.localUnavailable' })
      else if (!reply.ok) setNotice({ key: reply.error.code === 'media/edit' ? 'audio.localFailed' : 'audio.localUnknown',
        message: reply.error.code === 'media/edit' && reply.error.details.path !== undefined
          ? t('video.retainedFile', { message: reply.error.message, path: reply.error.details.path }) : reply.error.message })
      else {
        acknowledged = true
        await reload()
        if (current.current === key) setNotice({ key: 'audio.uploaded' })
      }
    } catch (error: unknown) {
      if (current.current === key) setNotice({ key: acknowledged ? 'audio.localRefreshFailed' : 'audio.localUnknown', ...error instanceof Error ? { message: error.message } : {} })
    } finally {
      if (current.current === key) { pending.current = undefined; setBusy(false) }
    }
  }
  return <>
    <input ref={picker} hidden type="file" accept="audio/*" disabled={!enabled || busy} aria-label={t('audio.upload')} onChange={(event) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (file !== undefined) void save(file)
    }} />
    <Button size="sm" variant="outline" disabled={!enabled || busy} onClick={() => { picker.current?.click() }}>{t('audio.upload')}</Button>
    {busy && <p className={css.message} role="status">{t('audio.uploading')}</p>}
    {notice !== undefined && <p className={css.message} role={notice.key === 'audio.uploaded' ? 'status' : 'alert'}>{t(notice.key, { message: notice.message ?? '' })}</p>}
  </>
}
