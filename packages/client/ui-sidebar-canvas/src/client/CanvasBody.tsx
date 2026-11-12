/** The canvas tab: reading, failure, empty, and drawn states of one Session's project canvas. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, IconFullscreenOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { CanvasInjected } from './face.ts'
import { LazyCanvasFlow } from './LazyCanvasFlow.tsx'
import { Inspector } from './Inspector.tsx'
import { StoryboardTable } from './StoryboardTable.tsx'
import { inspectorPlacement } from './model/inspector.ts'
import { EditHistory } from './model/history.ts'
import { movedForward, newNodeIds } from './model/changes.ts'
import clsx from 'clsx'
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
  const [tableId, setTableId] = useState<string>()
  const history = useRef(new EditHistory()).current
  const [fullscreen, setFullscreen] = useState(false)
  const seen = useRef<{ revision: number; document: CanvasDocument }>()
  const [added, setAdded] = useState<readonly string[]>([])
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
  const addedHere = useMemo(() => {
    const previous = seen.current
    const fresh = movedForward(previous?.revision, document.revision) ? newNodeIds(previous?.document, document) : []
    seen.current = { revision: document.revision, document }
    return fresh
  }, [document])
  useEffect(() => {
    if (addedHere.length === 0) return
    setAdded(addedHere)
    const timer = setTimeout(() => { setAdded([]) }, 1500)
    return () => { clearTimeout(timer) }
  }, [addedHere])
  const selected = selectedId === undefined ? undefined : document.nodes.find(node => node.id === selectedId)
  const table = tableId === undefined ? undefined : document.nodes.find(node => node.id === tableId)
  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `canvas-${state.view?.episode.id ?? 'canvas'}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return <section className={clsx(css.root, fullscreen && css.fullscreen)} data-sidebar-canvas
    data-fullscreen={fullscreen ? 'true' : undefined} ref={root}>
    <div className={css.canvasActions}>
      {added.length === 0 ? undefined : <span className={css.addedBadge} role="status">{t('canvas.added', { count: added.length })}</span>}
      <Button size="sm" variant="outline" onClick={exportJson}>{t('canvas.export')}</Button>
      <Button size="sm" variant="outline" icon={<IconFullscreenOutlineRegular />}
        aria-label={fullscreen ? t('canvas.exitFullscreen') : t('canvas.fullscreen')}
        onClick={() => { setFullscreen(value => !value) }}>
        {fullscreen ? t('canvas.exitFullscreen') : t('canvas.fullscreen')}
      </Button>
    </div>
    {state.status === 'failed' && <div className={css.notice} role="alert">
      <span className={css.noticeText}>{t('failed', { message: state.error })}</span>{retry}
    </div>}
    {state.notice !== undefined && <div className={css.notice} role="alert">
      <span className={css.noticeText}>{t('notice', { message: state.notice })}</span>
      <Button size="sm" className={css.dismiss} aria-label={t('dismiss')} onClick={dismiss}><IconCloseOutlineRegular /></Button>
    </div>}
    {document.nodes.length === 0
      ? <div className={css.center}><p className={css.message}>{t('empty')}</p></div>
      : <><LazyCanvasFlow document={document} readFile={readFile} t={t} edit={edit} reload={load}
        onSelect={setSelectedId} history={history} />
      {selected === undefined ? undefined : <Inspector
        document={document} node={selected} placement={inspectorPlacement(width)} capabilities={capabilities}
        edit={edit} close={() => { setSelectedId(undefined) }} openTable={setTableId} t={t}
      />}
      {table === undefined ? undefined : <StoryboardTable node={table} edit={edit} close={() => { setTableId(undefined) }} t={t} />}</>}
  </section>
}
