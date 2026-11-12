/** The canvas tab: reading, failure, empty, and drawn states of one Session's project canvas. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { CanvasInjected } from './face.ts'
import { LazyCanvasFlow } from './LazyCanvasFlow.tsx'
import { Inspector } from './Inspector.tsx'
import { inspectorPlacement } from './model/inspector.ts'
import type { NS } from './locales.ts'
import css from './CanvasBody.module.css'

/** Standard sidebar owner share plus the canvas face and localized copy. */
export type CanvasBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS> & InjectFace<CanvasInjected>

/**
 * Read the canvas when the tab mounts and draw whatever state it is in.
 * @param props - canvas state hook, edit and read calls, and copy.
 * @returns a spinner, a retryable failure, the empty hint, or the flow under any notice.
 */
export function CanvasBody({ useCanvas, load, edit, dismiss, readFile, capabilities, t }: CanvasBodyProps): ReactNode {
  const state = useCanvas(value => value)
  useEffect(() => { void load() }, [load])
  const root = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  const [selectedId, setSelectedId] = useState<string>()
  useEffect(() => {
    const element = root.current
    if (element === null) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(() => { setWidth(element.clientWidth) })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [state.view === undefined])
  const retry = <Button variant="outline" size="sm" onClick={() => { void load() }}>{t('retry')}</Button>
  if (state.view === undefined) {
    return <section className={css.root} data-sidebar-canvas>
      {state.status === 'failed'
        ? <div className={css.center}><p className={css.message} role="alert">{t('failed', { message: state.error })}</p>{retry}</div>
        : <div className={css.center} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={28} /></div>}
    </section>
  }
  const { document } = state.view
  const selected = selectedId === undefined ? undefined : document.nodes.find(node => node.id === selectedId)
  return <section className={css.root} data-sidebar-canvas ref={root}>
    {state.status === 'failed' && <div className={css.notice} role="alert">
      <span className={css.noticeText}>{t('failed', { message: state.error })}</span>{retry}
    </div>}
    {state.notice !== undefined && <div className={css.notice} role="alert">
      <span className={css.noticeText}>{t('notice', { message: state.notice })}</span>
      <Button size="sm" className={css.dismiss} aria-label={t('dismiss')} onClick={dismiss}><IconCloseOutlineRegular /></Button>
    </div>}
    {document.nodes.length === 0
      ? <div className={css.center}><p className={css.message}>{t('empty')}</p></div>
      : <><LazyCanvasFlow document={document} readFile={readFile} t={t} edit={edit} reload={load} onSelect={setSelectedId} />
        {selected === undefined ? undefined : <Inspector
          document={document} node={selected} placement={inspectorPlacement(width)} capabilities={capabilities}
          edit={edit} close={() => { setSelectedId(undefined) }} t={t}
        />}</>}
  </section>
}
