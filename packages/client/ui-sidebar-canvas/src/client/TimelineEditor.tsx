/** The full-screen editing application: shared conversation, cached video, parameters, and tracks. */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { fileMediaUrl, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type {
  CanvasDocument,
  Timeline,
  TimelineClipId,
  TimelineOperation,
  TimelineTrackId,
} from '@deepseek-ai/dsh-canvas/client'
import type { CanvasBodyProps } from './CanvasBody.tsx'
import type { CanvasState } from './canvas-source.ts'
import { TimelineClipForm } from './TimelineClipForm.tsx'
import { TimelineLibrary, TimelineSpecForm, TimelineTrackGain } from './TimelineSetup.tsx'
import { TimelineTracks } from './TimelineTracks.tsx'
import { TimelineHistory, type TimelineRestoreIntent } from './TimelineHistory.tsx'
import css from './TimelineEditor.module.css'
import { EditorContextNotice, type EditorContextNoticeState, type ReportEditorContext } from './editor-context.tsx'

type DraftKind = 'clip' | 'library' | 'spec' | 'track'
type Drafts = Partial<Record<DraftKind, { readonly document: Timeline | undefined; readonly canvas: CanvasDocument }>>
type Pane = 'agent' | 'preview' | 'parameters'
const EMPTY_CANVAS: CanvasDocument = { version: 3, revision: 0, nextId: 1, nodes: [], edges: [] }
const stateLabels = {
  stale: 'editor.state.stale',
  queued: 'editor.state.queued',
  rendering: 'editor.state.rendering',
  assembling: 'editor.state.assembling',
  ready: 'editor.state.ready',
  cancelled: 'editor.state.cancelled',
  interrupted: 'editor.state.interrupted',
  failed: 'editor.state.failed',
} as const
const noticeLabels = {
  read: 'editor.notice.read',
  edit: 'editor.notice.edit',
  conflict: 'editor.notice.conflict',
  unknown: 'editor.notice.unknown',
  render: 'editor.notice.render',
  export: 'editor.notice.export',
  unavailable: 'editor.notice.unavailable',
  history: 'editor.notice.history',
} as const

/** Stable local Factory component: both editor and main conversation use the same Session and Composer. */
function EditorChat({ renderSlot }: ConversationViewsProps) {
  return renderSlot('conversation.session', { view: 'chat' })
}

/** The owner supplies the current canvas scope; resources and timeline hooks are the renderer's seats. */
export type TimelineEditorProps = Pick<
  CanvasBodyProps,
  'useTimeline' | 'timeline' | 'useResource' | 'sessionId' | 'renderFactorySlot' | 't'
> & {
  readonly current: CanvasState['view']
  readonly canvasReady: boolean
  readonly reloadCanvas: CanvasBodyProps['load']
  readonly close: () => void
  readonly reportEditor?: ReportEditorContext
  readonly contextNotice?: EditorContextNoticeState
}

/** Draft baselines are captured only on user input and remain available through reads and disconnections. */
export function TimelineEditor({
  useTimeline,
  timeline,
  useResource,
  sessionId,
  renderFactorySlot,
  current,
  canvasReady,
  reloadCanvas,
  close,
  reportEditor,
  contextNotice,
  t,
}: TimelineEditorProps) {
  const state = useTimeline(value => value)
  const [selected, setSelected] = useState<TimelineClipId>()
  const [selectedTrack, setSelectedTrack] = useState<TimelineTrackId>()
  const [playhead, setPlayhead] = useState(0)
  const [pane, setPane] = useState<Pane>('preview')
  const [drafts, setDrafts] = useState<Drafts>({})
  const [draftInstance, setDraftInstance] = useState(0)
  const [pendingOwner, setPendingOwner] = useState<DraftKind | 'gesture'>()
  const [warning, setWarning] = useState(false)
  const [playbackFailed, setPlaybackFailed] = useState<string>()
  const [removing, setRemoving] = useState<{ track: TimelineTrackId; revision: number; count: number }>()
  const [history, setHistory] = useState<TimelineRestoreIntent>()
  const video = useRef<HTMLVideoElement>(null)
  const document = state.document
  const sameScope =
    current !== undefined &&
    state.binding !== undefined &&
    current.directory === state.binding.directory &&
    current.episode.id === state.binding.episode
  const contextChanged = current !== undefined && state.binding !== undefined && !sameScope
  const canvas = sameScope ? current.document : EMPTY_CANVAS
  const nodeRemoved =
    sameScope && canvasReady && !canvas.nodes.some(node => node.id === state.node && node.type === 'timeline')
  const dirty = Object.keys(drafts).length !== 0
  const busy = state.working || state.loading
  const blocked = busy || !state.trusted || !sameScope || !canvasReady || nodeRemoved
  useEffect(() => {
    if (state.binding === undefined || state.node === undefined) return
    reportEditor?.({
      scope: state.binding,
      application: 'timeline',
      revision: canvas.revision,
      available: !blocked,
      dirty,
      node: state.node,
      clips: selected === undefined ? [] : [selected],
      playheadMs: playhead,
      ...(document === undefined ? {} : { timelineRevision: document.revision }),
    })
  }, [reportEditor, state.binding, state.node, canvas.revision, blocked, dirty, selected, playhead, document?.revision])
  const render = state.render
  const running = render?.state === 'queued' || render?.state === 'rendering' || render?.state === 'assembling'
  const ready =
    state.trusted &&
    state.available &&
    sameScope &&
    canvasReady &&
    !nodeRemoved &&
    render?.state === 'ready' &&
    render.revision === document?.revision
  const path = ready ? render.path : undefined
  const resource = useResource<'file'>(path === undefined ? '' : sessionFileAddress(sessionId, path))
  const media =
    resource.status === 'live' && resource.value !== undefined
      ? fileMediaUrl(window.document.baseURI, resource.value.absolutePath)
      : undefined
  const readyUrl =
    media === undefined || resource.value === undefined
      ? undefined
      : `${media}&version=${encodeURIComponent(resource.value.version)}`
  const clipDoc = document ?? drafts.clip?.document
  const entry = clipDoc?.tracks
    .flatMap(track => track.clips.map(clip => ({ track, clip })))
    .find(entry => entry.clip.id === selected)
  const retainedClip = drafts.clip?.document?.tracks
    .flatMap(track => track.clips.map(clip => ({ track, clip })))
    .find(entry => entry.clip.id === selected)
  const clip = entry ?? retainedClip
  const libraryDoc = document ?? drafts.library?.document
  const trackDoc = document ?? drafts.track?.document
  const editable = (owner: DraftKind): boolean => !blocked && (state.pending.length === 0 || pendingOwner === owner)
  const markDraft = (owner: DraftKind, changed: boolean): void => {
    setDrafts((current) => {
      if (changed) return { ...current, [owner]: current[owner] ?? { document, canvas } }
      const { [owner]: _removed, ...remaining } = current
      return remaining
    })
    setWarning(false)
  }
  const discard = (owner: DraftKind): void => {
    if (pendingOwner === owner) {
      timeline.discard()
      setPendingOwner(undefined)
    }
  }
  const apply = async (
    owner: DraftKind | 'gesture',
    operations: readonly TimelineOperation[],
    revision: number,
    spec?: Timeline['spec'],
  ): Promise<boolean> => {
    if (blocked || (state.pending.length !== 0 && pendingOwner !== owner)) return false
    const ok = await timeline.edit(operations, revision, spec)
    setPendingOwner(ok ? undefined : owner)
    return ok
  }
  const select = (id: TimelineClipId | undefined, track?: TimelineTrackId): void => {
    if (dirty) {
      setWarning(true)
      return
    }
    setSelected(id)
    setSelectedTrack(track)
    setWarning(false)
    setPane('parameters')
  }
  const seek = (ms: number): void => {
    setPlayhead(ms)
    if (video.current !== null && video.current.readyState >= 1) video.current.currentTime = ms / 1000
  }
  const requestClose = (): void => {
    if (dirty) setWarning(true)
    else close()
  }
  const discardAll = (): void => {
    setDrafts({})
    setDraftInstance(value => value + 1)
    setWarning(false)
    setPendingOwner(undefined)
    timeline.discard()
  }
  const trackPending = state.pending.length !== 0
  const head = state.history?.find(entry => entry.revision === document?.revision)
  const step = (mode: 'undo' | 'redo'): void => {
    const revision = head?.[mode]
    if (revision === undefined || document === undefined) return
    const intent = { revision, baseRevision: document.revision, mode }
    void timeline.restore(revision, document.revision, mode).then((ok) => {
      if (!ok) setHistory(intent)
    })
  }
  return (
    <Modal open headless title={t('editor.title')} className={clsx(css.dialog)} onClose={requestClose}>
      <section className={css.root} data-timeline-editor>
        <header className={css.header}>
          <div>
            <h2 className={css.heading}>
              {canvas.nodes.find(node => node.id === state.node)?.title || t('editor.title')}
            </h2>
            {document !== undefined && (
              <span className={css.hint}>{t('editor.revision', { revision: document.revision })}</span>
            )}
          </div>
          <div className={css.actions}>
            <Button
              size="sm"
              disabled={blocked || dirty || trackPending || head?.undo === undefined}
              onClick={() => {
                step('undo')
              }}
            >
              {t('editor.undo')}
            </Button>
            <Button
              size="sm"
              disabled={blocked || dirty || trackPending || head?.redo === undefined}
              onClick={() => {
                step('redo')
              }}
            >
              {t('editor.redo')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || document === undefined}
              onClick={() => {
                if (document !== undefined) {
                  setHistory({
                    revision: state.history?.[1]?.revision ?? document.revision,
                    baseRevision: document.revision,
                    mode: 'restore',
                  })
                  void timeline.readHistory()
                }
              }}
            >
              {t('editor.history')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                blocked ||
                dirty ||
                trackPending ||
                running ||
                !state.available ||
                document === undefined ||
                !document.tracks.some(track => track.clips.length > 0)
              }
              onClick={() => {
                void timeline.render()
              }}
            >
              {t('editor.render')}
            </Button>
            {running && (
              <Button
                size="sm"
                disabled={state.working}
                onClick={() => {
                  void timeline.cancel()
                }}
              >
                {t('editor.cancel')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={blocked || dirty || trackPending || !ready}
              onClick={() => {
                void timeline.export()
              }}
            >
              {t('editor.export')}
            </Button>
            <Button size="sm" aria-label={t('editor.close')} data-modal-autofocus onClick={requestClose}>
              <IconCloseOutlineRegular />
            </Button>
          </div>
        </header>
        <EditorContextNotice state={contextNotice} t={t} />
        {(state.notice !== undefined || warning || trackPending || contextChanged || nodeRemoved || !canvasReady) && (
          <div className={css.notice} role="alert">
            {warning && <p>{t('editor.unsaved')}</p>}
            {contextChanged && <p>{t('editor.contextChanged')}</p>}
            {nodeRemoved && <p>{t('editor.nodeRemoved')}</p>}
            {!canvasReady && <p>{t('editor.canvasUnavailable')}</p>}
            {state.notice !== undefined && (
              <>
                <p>{t(noticeLabels[state.notice.kind])}</p>
                {state.notice.message !== undefined && (
                  <details>
                    <summary>{t('editor.details')}</summary>
                    {state.notice.message}
                  </details>
                )}
              </>
            )}
            {trackPending && <p>{t('editor.pending', { count: state.pending.length })}</p>}
            <div className={css.actions}>
              <Button
                size="sm"
                disabled={busy || contextChanged}
                onClick={() => {
                  setPlaybackFailed(undefined)
                  void reloadCanvas().then(() => timeline.load())
                }}
              >
                {t('editor.reload')}
              </Button>
              {trackPending && (
                <Button
                  size="sm"
                  disabled={blocked || dirty}
                  onClick={() => {
                    void timeline.merge().then((ok) => {
                      if (ok) setPendingOwner(undefined)
                    })
                  }}
                >
                  {t('editor.merge')}
                </Button>
              )}
              {(dirty || trackPending) && (
                <Button size="sm" onClick={discardAll}>
                  {t('editor.discard')}
                </Button>
              )}
            </div>
          </div>
        )}
        <nav className={css.mobileTabs} aria-label={t('editor.title')}>
          {(['agent', 'preview', 'parameters'] as const).map(value => (
            <Button
              size="sm"
              key={value}
              aria-pressed={pane === value}
              onClick={() => {
                setPane(value)
              }}
            >
              {t(paneLabels[value])}
            </Button>
          ))}
        </nav>
        <div className={css.grid}>
          <aside className={css.agent} data-active={pane === 'agent'} aria-label={t('editor.agent')}>
            <h3 className={css.sectionTitle}>{t('editor.agent')}</h3>
            <div className={css.conversation}>
              {renderFactorySlot(
                'conversation.content',
                { variant: 'embedded', phase: 'active', hero: false },
                { slots: { views: EditorChat } },
              )}
            </div>
          </aside>
          <section className={css.stage} data-active={pane === 'preview'} aria-label={t('editor.preview')}>
            <h3 className={css.sectionTitle}>{t('editor.preview')}</h3>
            <div className={css.preview}>
              {readyUrl !== undefined && playbackFailed !== readyUrl ? (
                <video
                  key={readyUrl}
                  ref={video}
                  className={css.video}
                  src={readyUrl}
                  controls
                  playsInline
                  preload="metadata"
                  onLoadedMetadata={(event) => {
                    event.currentTarget.currentTime = playhead / 1000
                  }}
                  onTimeUpdate={(event) => {
                    setPlayhead(Math.round(event.currentTarget.currentTime * 1000))
                  }}
                  onError={() => {
                    setPlaybackFailed(readyUrl)
                  }}
                />
              ) : (
                <div className={css.placeholder} role="status">
                  {state.loading || (ready && resource.status === 'loading') ? (
                    <StateDot state="ongoing" size={28} />
                  ) : (
                    t(
                      playbackFailed === readyUrl && readyUrl !== undefined
                        ? 'editor.playbackFailed'
                        : 'editor.noPreview',
                    )
                  )}
                </div>
              )}
            </div>
            {render !== undefined && (
              <div role="status">
                {t('editor.progress', {
                  revision: render.revision,
                  state: t(stateLabels[render.state]),
                  progress: Math.round(render.progress * 100),
                })}
              </div>
            )}
            {render?.error !== undefined && (
              <details>
                <summary>{t('editor.details')}</summary>
                {render.error.message}
              </details>
            )}
            {resource.status === 'failed' && (
              <div role="alert" className={css.error}>
                {t('editor.playbackFailed')}
                {resource.failure !== undefined && (
                  <details>
                    <summary>{t('editor.details')}</summary>
                    {resource.failure.message}
                  </details>
                )}
              </div>
            )}
            {!state.available && !state.loading && <p className={css.hint}>{t('editor.noMedia')}</p>}
            <p className={css.hint}>{t('editor.wait')}</p>
            <div className={css.actions}>
              <Button
                size="sm"
                disabled={blocked || !state.available || running || render === undefined}
                onClick={() => {
                  setPlaybackFailed(undefined)
                  void timeline.clear()
                }}
              >
                {t('editor.clear')}
              </Button>
              {readyUrl !== undefined && (
                <a href={readyUrl} download={`${state.node ?? 'timeline'}.mp4`}>
                  {t('editor.download')}
                </a>
              )}
            </div>
            {state.exported !== undefined && (
              <p role="status">
                {t('editor.exported', { node: state.exported.node, revision: state.exported.revision })}
              </p>
            )}
          </section>
          <aside className={css.parameters} data-active={pane === 'parameters'} aria-label={t('editor.parameters')}>
            <h3 className={css.sectionTitle}>{t('editor.parameters')}</h3>
            {clip !== undefined && clipDoc !== undefined && (
              <TimelineClipForm
                key={`${clip.clip.id}/${String(draftInstance)}`}
                clip={clip.clip}
                spec={clipDoc.spec}
                revision={document?.revision ?? clipDoc.revision}
                removed={document !== undefined && entry === undefined}
                image={
                  (sameScope ? canvas : (drafts.clip?.canvas ?? EMPTY_CANVAS)).nodes.find(
                    node => node.id === clip.clip.source?.node,
                  )?.type === 'image'
                }
                disabled={!editable('clip')}
                apply={(operations, revision) => apply('clip', operations, revision)}
                draftChanged={(dirty) => {
                  markDraft('clip', dirty)
                }}
                discard={() => {
                  discard('clip')
                }}
                t={t}
              />
            )}
            {clip === undefined && <p className={css.hint}>{t('editor.noSelection')}</p>}
            {trackDoc !== undefined && selectedTrack !== undefined && (
              <TimelineTrackGain
                key={`${selectedTrack}/${String(draftInstance)}`}
                document={trackDoc}
                selectedTrack={selectedTrack}
                disabled={!editable('track')}
                apply={(operations, revision) => apply('track', operations, revision)}
                draftChanged={(dirty) => {
                  markDraft('track', dirty)
                }}
                discard={() => {
                  discard('track')
                }}
                t={t}
              />
            )}
            {libraryDoc !== undefined && (
              <TimelineLibrary
                key={`library/${String(draftInstance)}`}
                document={libraryDoc}
                canvas={sameScope ? canvas : (drafts.library?.canvas ?? EMPTY_CANVAS)}
                selectedTrack={selectedTrack}
                playhead={playhead}
                disabled={!editable('library')}
                apply={(operations, revision) => apply('library', operations, revision)}
                draftChanged={(dirty) => {
                  markDraft('library', dirty)
                }}
                discard={() => {
                  discard('library')
                }}
                t={t}
              />
            )}
            <details open={document === undefined}>
              <summary>{t('editor.output')}</summary>
              <TimelineSpecForm
                key={`spec/${String(draftInstance)}`}
                document={document ?? drafts.spec?.document}
                disabled={!editable('spec')}
                apply={(operations, revision, spec) => apply('spec', operations, revision, spec)}
                draftChanged={(dirty) => {
                  markDraft('spec', dirty)
                }}
                discard={() => {
                  discard('spec')
                }}
                t={t}
              />
            </details>
          </aside>
          {document !== undefined ? (
            <TimelineTracks
              document={document}
              canvas={canvas}
              selected={entry?.clip.id}
              playhead={playhead}
              disabled={blocked || dirty || trackPending}
              select={(clip) => {
                const track = document.tracks.find(track => track.clips.some(candidate => candidate.id === clip.id))
                select(clip.id, track?.id)
              }}
              selectTrack={(track) => {
                select(undefined, track)
              }}
              seek={seek}
              apply={(operations, revision) => apply('gesture', operations, revision)}
              removeTrack={(id) => {
                const track = document.tracks.find(track => track.id === id)
                if (track !== undefined)
                  setRemoving({ track: id, revision: document.revision, count: track.clips.length })
              }}
              t={t}
            />
          ) : (
            <section className={css.tracks}>
              <p className={css.hint}>{t('editor.specHint')}</p>
            </section>
          )}
        </div>
        {history !== undefined && (
          <TimelineHistory
            initial={history}
            state={state}
            actions={timeline}
            disabled={blocked || dirty || trackPending}
            close={() => {
              setHistory(undefined)
            }}
            t={t}
          />
        )}
        {removing !== undefined && (
          <Modal
            open
            title={t('editor.removeTrack')}
            closeLabel={t('editor.back')}
            onClose={() => {
              setRemoving(undefined)
            }}
          >
            <p>{t('editor.removeTrackConfirm', { count: removing.count })}</p>
            <div className={css.actions}>
              <Button
                size="sm"
                disabled={blocked}
                onClick={() => {
                  void apply('gesture', [{ op: 'remove_track', track: removing.track }], removing.revision).then(
                    (ok) => {
                      if (ok) setRemoving(undefined)
                    },
                  )
                }}
              >
                {t('editor.confirmRemove')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setRemoving(undefined)
                }}
              >
                {t('editor.back')}
              </Button>
            </div>
          </Modal>
        )}
      </section>
    </Modal>
  )
}
const paneLabels = { agent: 'editor.agent', preview: 'editor.preview', parameters: 'editor.parameters' } as const
