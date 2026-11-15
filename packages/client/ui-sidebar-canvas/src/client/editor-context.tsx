/** Editor hints reach the model through the Host's logged runtime-context provider. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasEditorContext } from '@deepseek-ai/dsh-canvas/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasInjected } from './face.ts'
import type { NS } from './locales.ts'
import css from './CanvasBody.module.css'

/** Selection reports are ephemeral and contain no unsaved form values. */
export type ReportEditorContext = (context: CanvasEditorContext) => void

/** Data and action shared with the currently open editing surface. */
export interface EditorContextNoticeState {
  readonly failed: boolean
  readonly retry: () => void
}

/**
 * Publish the current editor hint and make a failed publication retryable.
 * @param publish - Session-bound Remote writer, absent on older injectors.
 * @param context - memoized editor hint; undefined clears the previous selection.
 * @returns publication status and a retry action, with markup owned by each editing surface.
 */
export function useEditorContext(publish: CanvasInjected['editorContext'], context: CanvasEditorContext | undefined): EditorContextNoticeState {
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (publish === undefined) return
    let live = true
    setFailed(false)
    void publish(context).then((result) => { if (live) setFailed(!result.ok) }, (_error: unknown) => { if (live) setFailed(true) })
    return () => { live = false }
  }, [publish, context, retry])
  useEffect(() => () => {
    if (publish !== undefined) void publish(undefined).then((result) => {
      if (!result.ok) console.warn('Could not clear canvas editor context', result.error)
    }, (error: unknown) => { console.warn('Could not clear canvas editor context', error) })
  }, [publish])
  const retryPublication = useCallback(() => { setRetry(value => value + 1) }, [])
  return useMemo(() => ({ failed, retry: retryPublication }), [failed, retryPublication])
}

/**
 * Render publication recovery on the active canvas or editing application.
 * @param props - publication state and canvas-owned copy.
 * @returns an accessible retry notice while selection delivery is unconfirmed.
 */
export function EditorContextNotice({ state, t }: { readonly state: EditorContextNoticeState | undefined; readonly t: PropsLocale<typeof NS>['t'] }): ReactNode {
  return state?.failed === true ? <div className={css.notice} role="alert"><span className={css.noticeText}>{t('editor.selectionFailed')}</span>
    <Button size="sm" variant="outline" onClick={state.retry}>{t('retry')}</Button></div> : undefined
}
