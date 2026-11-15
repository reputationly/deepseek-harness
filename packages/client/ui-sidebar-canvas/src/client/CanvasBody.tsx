/** The canvas tab: reading, failure, empty, and drawn states of one Session's project canvas. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  IconCloseOutlineRegular,
  IconFullscreenOutlineRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  Bible,
  CanvasDocument,
  CanvasEditorContext,
  CanvasNodeId,
  CanvasScope,
  VersionId,
} from '@deepseek-ai/dsh-canvas/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { InjectFace, PropsLocale, PropsRuntime, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { CanvasInjected } from './face.ts'
import { CanvasFlow, type CanvasFlowProps } from './CanvasFlow.tsx'
import { Inspector } from './Inspector.tsx'
import { useGenerationControls } from './GenerationControls.tsx'
import { StoryboardTable } from './StoryboardTable.tsx'
import { BibleAssetsPanel } from './BibleAssetsPanel.tsx'
import { TimelineEditor } from './TimelineEditor.tsx'
import { AudioEditor, type AudioOpening } from './AudioEditor.tsx'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import { inspectorPlacement } from './model/inspector.ts'
import { EditHistory, type HistoryDirection } from './model/history.ts'
import { movedForward, newNodeIds } from './model/changes.ts'
import clsx from 'clsx'
import type { NS } from './locales.ts'
import css from './CanvasBody.module.css'
import { EditorContextNotice, useEditorContext } from './editor-context.tsx'

/** Standard sidebar owner share plus the canvas face and localized copy. */
export type CanvasBodyProps = PropsRuntime<'sidebar.right.pane.tab'> &
  PropsRenderFactories &
  PropsLocale<typeof NS> &
  InjectFace<CanvasInjected>

/**
 * Name a canvas download, including the episode when known.
 * @param episode - optional episode metadata.
 * @returns JSON download filename.
 */
export function exportFilename(episode: { readonly id: string } | undefined): string {
  return `canvas-${episode?.id ?? 'canvas'}.json`
}

/**
 * Read the canvas when the tab mounts and draw whatever state it is in.
 * @param props - canvas state hook, edit and read calls, and copy.
 * @returns a spinner, a retryable failure, the empty hint, or the flow under any notice.
 */
export function CanvasBody({
  useCanvas,
  useLocaleState,
  useTimeline,
  timeline,
  useResource,
  sessionId,
  renderFactorySlot,
  load,
  edit,
  dismiss,
  readFile,
  previewVideo,
  videoPath,
  editMedia,
  importVideo,
  importAudio,
  editorContext,
  capabilities,
  bible,
  planNodes,
  generateNodes,
  t,
}: CanvasBodyProps): ReactNode {
  const state = useCanvas(value => value)
  const localeRevision = useLocaleState(value => value.revision)
  useEffect(() => {
    void load()
  }, [load])
  const root = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  const [selectedId, setSelectedId] = useState<string>()
  const [tableId, setTableId] = useState<string>()
  const [editorOpen, setEditorOpen] = useState(false)
  const [audioOpening, setAudioOpening] = useState<AudioOpening>()
  const [childEditor, setChildEditor] = useState<CanvasEditorContext>()
  const [inspectorDirty, setInspectorDirty] = useState(false)
  const [previewed, setPreviewed] = useState<{
    readonly scope: CanvasScope
    readonly node: CanvasNodeId
    readonly version: VersionId | undefined
  }>()
  const history = useRef(new EditHistory()).current
  const [historyEpoch, setHistoryEpoch] = useState(0)
  const [fullscreen, setFullscreen] = useState(false)
  const mount = useRef<HTMLDivElement>(null)
  const [portal] = useState(() => {
    const element = window.document.createElement('div')
    element.style.display = 'contents'
    return element
  })
  useLayoutEffect(() => {
    const parent = fullscreen ? window.document.body : mount.current
    parent?.appendChild(portal)
    return () => {
      portal.remove()
    }
  }, [fullscreen, portal, state.view === undefined])
  const seen = useRef<{ revision: number; document: CanvasDocument }>()
  const [added, setAdded] = useState<readonly string[]>([])
  const [focus, setFocus] = useState<CanvasFlowProps['focus']>(undefined)
  const [panel, setPanel] = useState(false)
  const [shared, setShared] = useState<Bible>()
  const scope = useMemo<CanvasScope | undefined>(
    () => (state.view === undefined ? undefined : { directory: state.view.directory, episode: state.view.episode.id }),
    [state.view?.directory, state.view?.episode.id],
  )
  const timelineState = useTimeline(value => value)
  const timelineSummary = useMemo<CanvasFlowProps['timelineSummary']>(() => {
    const { binding, document, node, trusted } = timelineState
    if (
      !trusted ||
      document === undefined ||
      node === undefined ||
      scope === undefined ||
      binding?.directory !== scope.directory ||
      binding.episode !== scope.episode
    )
      return undefined
    const clips = document.tracks.flatMap(track => track.clips)
    return {
      node,
      clips: clips.length,
      durationMs: clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0),
    }
  }, [timelineState.document, timelineState.node, timelineState.binding, timelineState.trusted, scope])
  const previewChanged = useCallback(
    (node: CanvasNodeId, version: VersionId | undefined): void => {
      if (scope !== undefined) setPreviewed({ scope, node, version })
    },
    [scope],
  )
  useEffect(() => {
    setInspectorDirty(false)
  }, [scope, selectedId])
  const context = useMemo<CanvasEditorContext | undefined>(() => {
    if (scope === undefined || state.view === undefined) return undefined
    if (editorOpen || audioOpening !== undefined) {
      return childEditor?.scope.directory === scope.directory && childEditor.scope.episode === scope.episode
        ? childEditor
        : undefined
    }
    const node = tableId ?? selectedId
    const version = previewed?.scope === scope && previewed.node === node ? previewed.version : undefined
    return {
      scope,
      application: 'canvas',
      revision: state.view.document.revision,
      available: state.status === 'ready',
      ...(tableId !== undefined || panel ? {} : { dirty: inspectorDirty }),
      ...(node === undefined ? {} : { node: brandString<CanvasNodeId>(node) }),
      ...(version === undefined ? {} : { version }),
    }
  }, [
    scope,
    state.view,
    state.status,
    editorOpen,
    audioOpening,
    childEditor,
    tableId,
    selectedId,
    previewed,
    inspectorDirty,
    panel,
  ])
  const contextNotice = useEditorContext(editorContext, context)
  const scopedVideoPreview = useMemo<CanvasFlowProps['previewVideo']>(
    () =>
      previewVideo === undefined || scope === undefined
        ? undefined
        : (node: CanvasNodeId, version: VersionId, signal: AbortSignal) => previewVideo(node, version, scope, signal),
    [previewVideo, scope],
  )
  const scopedReadFile = useMemo<CanvasFlowProps['readFile']>(
    () =>
      scope === undefined
        ? readFile
        : (path: string, signal: AbortSignal) => readFile(resolveWorkspacePath(scope.directory, path), signal),
    [readFile, scope],
  )
  const videoFiles = useMemo<CanvasFlowProps['videoFiles']>(
    () => (scope === undefined || videoPath === undefined ? undefined : { scope, videoPath, useResource, sessionId }),
    [scope, videoPath, useResource, sessionId],
  )
  const generation = useGenerationControls({
    document: state.view?.document,
    ...(scope === undefined ? {} : { scope }),
    ...(planNodes === undefined ? {} : { planNodes }),
    ...(generateNodes === undefined ? {} : { generateNodes }),
    t,
  })
  const generateNode = useCallback(
    (nodeId: string, scope?: CanvasScope): void => {
      generation.generate([nodeId], scope)
    },
    [generation.generate],
  )
  const editWithHistory = useCallback(
    async (operations: Parameters<typeof edit>[0], options?: Parameters<typeof edit>[1]): Promise<void> => {
      await edit(operations, {
        ...options,
        ...(options?.scope !== undefined || state.view === undefined
          ? {}
          : { scope: { directory: state.view.directory, episode: state.view.episode.id } }),
        onAcknowledged: (document, applied, result) => {
          history.record(document, applied, t('undo.edit'), result)
          options?.onAcknowledged?.(document, applied, result)
        },
      })
    },
    [edit, history, t, state.view?.directory, state.view?.episode.id],
  )
  const editHistory = useCallback(
    async (operations: Parameters<typeof edit>[0], direction: HistoryDirection): Promise<void> => {
      const resetInspectorDraft = { value: false }
      await edit(operations, {
        onApplied: (document, applied, result) => {
          if (direction === 'redo') history.refreshAfterRedo(document, applied, result)
          const skipped = new Set(result.skipped.map(entry => entry.index))
          resetInspectorDraft.value = operations.some(
            (operation, index) => operation.op === 'set_gen' && operation.node === selectedId && !skipped.has(index),
          )
        },
      })
      if (resetInspectorDraft.value) setHistoryEpoch(epoch => epoch + 1)
    },
    [edit, history, selectedId],
  )
  useEffect(() => {
    const element = root.current
    if (element === null) return
    setWidth(element.clientWidth)
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [state.view === undefined, fullscreen])
  useEffect(() => {
    if (!fullscreen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) setFullscreen(false)
    }
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('keydown', close)
    }
  }, [fullscreen])
  const visibleDocument = state.view?.document
  const addedHere = useMemo(() => {
    if (visibleDocument === undefined) return []
    const previous = seen.current
    const fresh = movedForward(previous?.revision, visibleDocument.revision)
      ? newNodeIds(previous?.document, visibleDocument)
      : []
    seen.current = { revision: visibleDocument.revision, document: visibleDocument }
    return fresh
  }, [visibleDocument])
  useEffect(() => {
    if (addedHere.length === 0) return
    setAdded(addedHere)
  }, [addedHere])
  const retry = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void load()
      }}
    >
      {t('retry')}
    </Button>
  )
  const audioDocument =
    state.view?.directory === audioOpening?.directory && state.view?.episode.id === audioOpening?.episode
      ? state.view?.document
      : undefined
  const editor = (
    <>
      {editorOpen && (
        <TimelineEditor
          useTimeline={useTimeline}
          timeline={timeline}
          useResource={useResource}
          sessionId={sessionId}
          renderFactorySlot={renderFactorySlot}
          current={state.view}
          canvasReady={state.status === 'ready'}
          reloadCanvas={load}
          reportEditor={setChildEditor}
          contextNotice={contextNotice}
          close={() => {
            setEditorOpen(false)
          }}
          t={t}
        />
      )}
      {audioOpening !== undefined && (
        <AudioEditor
          opening={audioOpening}
          document={audioDocument}
          ready={state.status === 'ready'}
          useResource={useResource}
          sessionId={sessionId}
          renderFactorySlot={renderFactorySlot}
          capabilities={capabilities}
          edit={editWithHistory}
          reload={load}
          reportEditor={setChildEditor}
          contextNotice={contextNotice}
          {...(editMedia === undefined ? {} : { editMedia })}
          {...(importAudio === undefined ? {} : { importAudio })}
          {...(state.notice === undefined || audioDocument === undefined
            ? {}
            : {
              notice:
                  state.noticeCode === 'scope'
                    ? t('canvas.scopeChanged')
                    : state.noticeCode === 'unknown'
                      ? t('canvas.outcomeUnknown', { message: state.notice })
                      : state.conflict
                        ? t('conflict')
                        : t('notice', { message: state.notice }),
            })}
          {...(generation.note === undefined ? {} : { generationNote: generation.note })}
          {...(planNodes === undefined || generateNodes === undefined ? {} : { generate: generateNode })}
          close={() => {
            setAudioOpening(undefined)
          }}
          t={t}
        />
      )}
    </>
  )
  if (state.view === undefined) {
    return (
      <>
        <section className={css.root} data-sidebar-canvas>
          {state.status === 'failed' ? (
            <div className={css.center}>
              <p className={css.message} role="alert">
                {t('failed', { message: state.error })}
              </p>
              {retry}
            </div>
          ) : (
            <div className={css.center} role="status" aria-label={t('loading')}>
              <StateDot state="ongoing" size={28} />
            </div>
          )}
        </section>
        {editor}
      </>
    )
  }
  const { document, episode } = state.view
  const locate = (nodeIds: readonly string[]): void => {
    const visible = nodeIds
    if (visible.length === 0) return
    setFocus(current => ({ nodeIds: visible, request: (current?.request ?? 0) + 1 }))
    setSelectedId(visible.length === 1 ? visible[0] : undefined)
    setPanel(false)
  }
  const selected = selectedId === undefined ? undefined : document.nodes.find(node => node.id === selectedId)
  const table = tableId === undefined ? undefined : document.nodes.find(node => node.id === tableId)
  const openTimeline = (node: CanvasNodeId): void => {
    if (state.view === undefined) return
    void timeline.open(node, { directory: state.view.directory, episode: state.view.episode.id })
    setChildEditor(undefined)
    setEditorOpen(true)
  }
  const openAudio = (id: CanvasNodeId): void => {
    const view = state.view
    const node = view?.document.nodes.find(node => node.id === id && node.type === 'audio')
    if (view !== undefined && node !== undefined) {
      setChildEditor(undefined)
      setAudioOpening({ directory: view.directory, episode: view.episode.id, document: view.document, node })
    }
  }
  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = exportFilename(episode)
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const content = (
    <section
      className={clsx(css.root, fullscreen && css.fullscreen)}
      data-sidebar-canvas
      data-fullscreen={fullscreen ? 'true' : undefined}
      ref={root}
    >
      {!editorOpen && audioOpening === undefined && <EditorContextNotice state={contextNotice} t={t} />}
      {table === undefined ? (
        <div className={css.canvasActions}>
          {added.length === 0 ? undefined : (
            <span role="status">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  locate(added)
                  setAdded([])
                }}
              >
                {t('canvas.added', { count: added.length })} · {t('canvas.locateAdded')}
              </Button>
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setPanel(value => !value)
              if (shared === undefined)
                void bible()
                  .then((result) => {
                    setShared(result.bible)
                  })
                  .catch(() => undefined)
            }}
          >
            {t('bible.tab')}
          </Button>
          <Button size="sm" variant="outline" onClick={exportJson}>
            {t('canvas.export')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={state.status !== 'ready'}
            onClick={() => {
              void editWithHistory(
                [
                  {
                    op: 'add',
                    type: 'video',
                    title: t('video.newTitle'),
                    gen: { kind: 'video', prompt: '', params: {} },
                    ref: 'new-video',
                  },
                ],
                {
                  onApplied: (_before, _operations, result) => {
                    if (result.refs['new-video'] !== undefined) setSelectedId(result.refs['new-video'])
                  },
                },
              )
            }}
          >
            {t('video.new')}
          </Button>
          {(['music', 'speech'] as const).map(kind => (
            <Button
              key={kind}
              size="sm"
              variant="outline"
              onClick={() => {
                void editWithHistory(
                  [
                    {
                      op: 'add',
                      type: 'audio',
                      title: t(kind === 'music' ? 'audio.newMusic' : 'audio.newSpeech'),
                      gen: { kind, prompt: '', params: {} },
                      ref: 'new-audio',
                    },
                  ],
                  {
                    onApplied: (_before, _operations, result) => {
                      if (result.refs['new-audio'] !== undefined) setSelectedId(result.refs['new-audio'])
                    },
                  },
                )
              }}
            >
              {t(kind === 'music' ? 'audio.newMusic' : 'audio.newSpeech')}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void editWithHistory(
                [{ op: 'add', type: 'timeline', title: t('editor.newTitle'), ref: 'timeline-editor' }],
                {
                  onApplied: (_before, _operations, result) => {
                    const node = result.refs['timeline-editor']
                    if (node !== undefined) openTimeline(node)
                  },
                },
              )
            }}
          >
            {t('editor.new')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            icon={<IconFullscreenOutlineRegular />}
            aria-label={fullscreen ? t('canvas.exitFullscreen') : t('canvas.fullscreen')}
            onClick={() => {
              setFullscreen(value => !value)
            }}
          >
            {fullscreen ? t('canvas.exitFullscreen') : t('canvas.fullscreen')}
          </Button>
        </div>
      ) : undefined}
      {state.status === 'failed' && (
        <div className={css.notice} role="alert">
          <span className={css.noticeText}>{t('failed', { message: state.error })}</span>
          {retry}
        </div>
      )}
      {state.notice !== undefined && (
        <div className={css.notice} role="alert">
          <span className={css.noticeText}>
            {state.noticeCode === 'scope'
              ? t('canvas.scopeChanged')
              : state.noticeCode === 'unknown'
                ? t('canvas.outcomeUnknown', { message: state.notice })
                : state.conflict
                  ? t('conflict')
                  : t('notice', { message: state.notice })}
          </span>
          <Button size="sm" className={css.dismiss} aria-label={t('dismiss')} onClick={dismiss}>
            <IconCloseOutlineRegular />
          </Button>
        </div>
      )}
      {document.nodes.length === 0 ? (
        <div className={css.center}>
          <p className={css.message}>{t('empty')}</p>
        </div>
      ) : (
        <>
          <CanvasFlow
            document={document}
            segments={state.view.segments}
            readFile={scopedReadFile}
            t={t}
            edit={editWithHistory}
            localeRevision={localeRevision}
            {...(scopedVideoPreview === undefined ? {} : { previewVideo: scopedVideoPreview })}
            {...(videoFiles === undefined ? {} : { videoFiles })}
            {...(timelineSummary === undefined ? {} : { timelineSummary })}
            {...(focus === undefined ? {} : { focus })}
            historyEdit={editHistory}
            {...(planNodes === undefined || generateNodes === undefined ? {} : { generate: generateNode })}
            reload={load}
            onSelect={setSelectedId}
            onOpen={(node) => {
              if (document.nodes.find(candidate => candidate.id === node)?.type === 'timeline') openTimeline(node)
              else openAudio(node)
            }}
            history={history}
          />
          {selected === undefined ? undefined : (
            <Inspector
              key={`${scope?.directory}/${scope?.episode}`}
              document={document}
              node={selected}
              placement={inspectorPlacement(width)}
              capabilities={capabilities}
              disabled={state.status !== 'ready'}
              {...(scope === undefined || editMedia === undefined || videoPath === undefined
                ? {}
                : {
                  video: {
                    scope,
                    editMedia,
                    videoPath,
                    useResource,
                    sessionId,
                    reload: load,
                    locate: setSelectedId,
                    previewChanged,
                    ...(importVideo === undefined ? {} : { importVideo }),
                  },
                })}
              dirtyChanged={setInspectorDirty}
              edit={editWithHistory}
              historyEpoch={historyEpoch}
              close={() => {
                setSelectedId(undefined)
              }}
              openTable={setTableId}
              openTimeline={openTimeline}
              openAudio={openAudio}
              {...(planNodes === undefined || generateNodes === undefined ? {} : { generate: generateNode })}
              t={t}
            />
          )}
          {table === undefined ? undefined : (
            <StoryboardTable
              node={table}
              edit={editWithHistory}
              close={() => {
                setTableId(undefined)
              }}
              t={t}
              /* v8 ignore next -- older Host views may omit segments; the table then shows no segmentation */
              segments={state.view.segments[table.id] ?? []}
            />
          )}
          {panel ? (
            <BibleAssetsPanel
              document={document}
              bible={shared}
              edit={editWithHistory}
              close={() => {
                setPanel(false)
              }}
              {...(planNodes === undefined || generateNodes === undefined ? {} : { generate: generateNode })}
              select={(nodeId) => {
                locate([nodeId])
              }}
              t={t}
            />
          ) : undefined}
        </>
      )}
      {generation.feedback}
    </section>
  )
  return (
    <>
      <div className={css.mount} ref={mount}>
        {createPortal(content, portal)}
      </div>
      {editor}
    </>
  )
}
