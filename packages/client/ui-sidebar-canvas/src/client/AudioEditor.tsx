/** Canvas audio application: the shared Agent conversation, immutable versions, and generation settings. */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasDocument, CanvasNode, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { fileMediaUrl, resolveWorkspacePath, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { CanvasBodyProps } from './CanvasBody.tsx'
import { Inspector } from './Inspector.tsx'
import type { InspectorProps } from './Inspector.tsx'
import { AudioLocalControls, emptyAudioEditDraft, type AudioEditDraft } from './AudioLocalControls.tsx'
import { AudioImportControls } from './AudioImportControls.tsx'
import css from './AudioEditor.module.css'
import { EditorContextNotice, type EditorContextNoticeState, type ReportEditorContext } from './editor-context.tsx'

/** Trusted opening snapshot retained solely to preserve the form through disconnects and scope changes. */
export interface AudioOpening {
  readonly directory: string
  readonly episode: EpisodeId
  readonly document: CanvasDocument
  readonly node: CanvasNode
}

/** Media reads use the injected resource seat; edits use the same revision-checked owner as the canvas. */
export type AudioEditorProps = Pick<
  CanvasBodyProps,
  'useResource' | 'sessionId' | 'renderFactorySlot' | 'capabilities' | 'editMedia' | 'importAudio' | 't'
> & {
  readonly opening: AudioOpening
  /** Undefined when the original project and episode are no longer the current binding. */
  readonly document: CanvasDocument | undefined
  readonly ready: boolean
  /** Localized report owned by the canvas source. */
  readonly notice?: string
  readonly generationNote?: string
  readonly edit: InspectorProps['edit']
  readonly generate?: InspectorProps['generate']
  readonly reload: () => Promise<void>
  readonly close: () => void
  readonly reportEditor?: ReportEditorContext
  readonly contextNotice?: EditorContextNoticeState
}

function EditorChat({ renderSlot }: ConversationViewsProps) {
  return renderSlot('conversation.session', { view: 'chat' })
}
const paneLabels = { agent: 'audio.agent', preview: 'audio.preview', parameters: 'audio.parameters' } as const

/**
 * Previewing another version never adopts it; closing a dirty form requires an explicit discard.
 * @param props - captured audio target, current data, shared conversation, and scoped actions.
 * @returns the music or speech application, retaining drafts while its target is unavailable.
 */
export function AudioEditor({
  opening,
  document,
  ready,
  notice,
  generationNote,
  edit,
  editMedia,
  importAudio,
  capabilities,
  generate,
  useResource,
  sessionId,
  renderFactorySlot,
  reload,
  close,
  reportEditor,
  contextNotice,
  t,
}: AudioEditorProps) {
  const scope = useMemo(
    () => ({ directory: opening.directory, episode: opening.episode }),
    [opening.directory, opening.episode],
  )
  const [selected, setSelected] = useState<VersionId | undefined>(
    () => opening.node.activeVersion ?? opening.node.versions?.at(-1)?.id,
  )
  const [dirty, setDirty] = useState(false)
  const [localDrafts, setLocalDrafts] = useState<ReadonlyMap<VersionId, AudioEditDraft>>(new Map())
  const anyDirty = dirty || localDrafts.size > 0
  const [warning, setWarning] = useState(false)
  const [adopting, setAdopting] = useState(false)
  const [adoptFailed, setAdoptFailed] = useState(false)
  const [playbackFailed, setPlaybackFailed] = useState<string>()
  const [pane, setPane] = useState<keyof typeof paneLabels>('preview')
  const retained = useRef({ document: opening.document, node: opening.node })
  const currentNode = ready
    ? document?.nodes.find(node => node.id === opening.node.id && node.type === 'audio')
    : undefined
  if (currentNode !== undefined && document !== undefined) retained.current = { document, node: currentNode }
  const node = currentNode ?? retained.current.node
  const available = ready && currentNode !== undefined
  const versions = node.versions ?? []
  const selectionMissing = selected !== undefined && !versions.some(version => version.id === selected)
  const version = selectionMissing
    ? undefined
    : (versions.find(version => version.id === selected) ?? versions.at(-1))
  const previewId = version?.id
  useEffect(() => {
    reportEditor?.({
      scope,
      application: node.gen?.kind === 'speech' ? 'speech' : 'music',
      revision: document?.revision ?? opening.document.revision,
      available,
      dirty: anyDirty,
      node: node.id,
      ...(selected === undefined ? {} : { version: selected }),
    })
  }, [
    reportEditor,
    scope,
    node.id,
    node.gen?.kind,
    document?.revision,
    opening.document.revision,
    available,
    anyDirty,
    selected,
  ])
  useEffect(() => {
    if (selected === undefined && previewId !== undefined) setSelected(previewId)
  }, [selected, previewId])
  const score = version?.params?.abc
  const path =
    !available || version?.path === undefined ? undefined : resolveWorkspacePath(opening.directory, version.path)
  const resource = useResource<'file'>(path === undefined ? '' : sessionFileAddress(sessionId, path))
  const mediaUrl =
    path === undefined || resource.status !== 'live' || resource.value === undefined
      ? undefined
      : fileMediaUrl(window.document.baseURI, resource.value.absolutePath)
  const url =
    mediaUrl === undefined || resource.value === undefined
      ? undefined
      : `${mediaUrl}&version=${encodeURIComponent(resource.value.version)}`
  const requestClose = (): void => {
    if (anyDirty) setWarning(true)
    else close()
  }
  const title = node.gen?.kind === 'speech' ? t('audio.speechTitle') : t('audio.musicTitle')
  const adopt = async (): Promise<void> => {
    if (!available || document === undefined || version === undefined) return
    setAdopting(true)
    setAdoptFailed(false)
    try {
      await edit([{ op: 'set_version', node: node.id, version: version.id }], {
        baseRevision: document.revision,
        scope,
      })
    } catch (_error: unknown) {
      setAdoptFailed(true)
    } finally {
      setAdopting(false)
    }
  }
  return (
    <Modal open headless title={title} className={clsx(css.dialog)} onClose={requestClose}>
      <section className={css.root} data-audio-editor>
        <header className={css.header}>
          <h2 className={css.heading}>
            {title} · {node.title}
          </h2>
          <div className={css.actions}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPlaybackFailed(undefined)
                void reload()
              }}
            >
              {t('refresh')}
            </Button>
            <Button size="sm" aria-label={t('audio.close')} data-modal-autofocus onClick={requestClose}>
              <IconCloseOutlineRegular />
            </Button>
          </div>
        </header>
        <EditorContextNotice state={contextNotice} t={t} />
        {(!available || (warning && anyDirty) || notice !== undefined || adoptFailed) && (
          <div className={css.notice} role="alert">
            {!available && <p>{t('audio.scopeChanged')}</p>}
            {notice !== undefined && <p>{notice}</p>}
            {adoptFailed && <p>{t('audio.adoptFailed')}</p>}
            {warning && anyDirty && (
              <>
                <p>{t('audio.unsaved')}</p>
                <Button size="sm" onClick={close}>
                  {t('audio.discardClose')}
                </Button>
              </>
            )}
          </div>
        )}
        <nav className={css.tabs} aria-label={title}>
          {(Object.keys(paneLabels) as (keyof typeof paneLabels)[]).map(value => (
            <Button
              key={value}
              size="sm"
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
          <aside
            className={css.agent}
            data-active={pane === 'agent'}
            aria-label={t('audio.agent')}
            onFocusCapture={() => {
              setPane('agent')
            }}
          >
            <h3 className={css.sectionTitle}>{t('audio.agent')}</h3>
            <div className={css.conversation}>
              {renderFactorySlot(
                'conversation.content',
                { variant: 'embedded', phase: 'active', hero: false },
                { slots: { views: EditorChat } },
              )}
            </div>
          </aside>
          <section
            className={css.preview}
            data-active={pane === 'preview'}
            aria-label={t('audio.preview')}
            onFocusCapture={() => {
              setPane('preview')
            }}
          >
            <h3 className={css.sectionTitle}>{t('audio.preview')}</h3>
            {importAudio !== undefined && (
              <AudioImportControls
                node={node.id}
                scope={scope}
                enabled={available && !adopting}
                upload={importAudio}
                reload={reload}
                t={t}
              />
            )}
            {generationNote !== undefined && (
              <p className={css.message} role="status">
                {generationNote}
              </p>
            )}
            {node.status !== undefined && (
              <div className={css.actions} role="status">
                <StateDot state={node.status.state === 'failed' ? 'error' : 'ongoing'} />
                {node.status.state === 'failed' ? (
                  <p className={css.message}>{node.status.error}</p>
                ) : (
                  <span>{t('media.loading')}</span>
                )}
              </div>
            )}
            {(versions.length > 0 || selectionMissing) && (
              <label className={css.field}>
                <span>{t('inspector.versions')}</span>
                <select
                  className={css.select}
                  value={version?.id ?? ''}
                  onChange={(event) => {
                    const picked = versions.find(version => version.id === event.target.value)
                    if (picked !== undefined) setSelected(picked.id)
                  }}
                >
                  {selectionMissing && (
                    <option value="" disabled>
                      {t('audio.versionMissing')}
                    </option>
                  )}
                  {versions.map((item, index) => (
                    <option key={item.id} value={item.id}>
                      {t('inspector.versionLabel', { n: index + 1 })} ·{' '}
                      {item.model ?? t(item.origin === 'agent' ? 'audio.generatedVersion' : 'audio.manualVersion')}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {version === undefined ? (
              <p className={css.hint} role={selectionMissing ? 'alert' : undefined}>
                {t(selectionMissing ? 'audio.versionMissing' : 'audio.empty')}
              </p>
            ) : (
              <>
                {node.activeVersion !== version.id && <p className={css.hint}>{t('media.candidate')}</p>}
                {url !== undefined && playbackFailed !== url ? (
                  <audio
                    key={url}
                    className={css.audio}
                    src={url}
                    controls
                    preload="metadata"
                    onError={() => {
                      setPlaybackFailed(url)
                    }}
                  />
                ) : (
                  <p
                    className={css.hint}
                    role={
                      resource.status === 'failed' || (playbackFailed === url && url !== undefined) ? 'alert' : 'status'
                    }
                  >
                    {t(
                      (playbackFailed === url && url !== undefined) || resource.status === 'failed'
                        ? 'audio.playbackFailed'
                        : 'media.loading',
                    )}
                  </p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!available || adopting || anyDirty || node.activeVersion === version.id}
                  onClick={() => {
                    void adopt()
                  }}
                >
                  {t('inspector.useVersion')}
                </Button>
                {typeof score === 'string' && score !== '' && (
                  <details className={css.score}>
                    <summary>{t('audio.score')}</summary>
                    <pre>{score}</pre>
                  </details>
                )}
              </>
            )}
            {editMedia !== undefined && (
              <AudioLocalControls
                node={node.id}
                selected={selected ?? previewId}
                version={version}
                scope={scope}
                enabled={available && !adopting}
                drafts={localDrafts}
                edit={editMedia}
                reload={reload}
                t={t}
                preview={setSelected}
                change={(id, draft) => {
                  setLocalDrafts((current) => {
                    const next = new Map(current)
                    if (JSON.stringify(draft) === JSON.stringify(emptyAudioEditDraft)) next.delete(id)
                    else next.set(id, draft)
                    return next
                  })
                }}
                saved={(id) => {
                  setLocalDrafts((current) => {
                    const next = new Map(current)
                    next.delete(id)
                    return next
                  })
                }}
              />
            )}
          </section>
          <aside
            className={css.parameters}
            data-active={pane === 'parameters'}
            aria-label={t('audio.parameters')}
            onFocusCapture={() => {
              setPane('parameters')
            }}
          >
            <h3 className={css.sectionTitle}>{t('audio.parameters')}</h3>
            <Inspector
              document={document ?? retained.current.document}
              node={node}
              placement="sidebar"
              embedded
              disabled={!available || adopting || selectionMissing}
              capabilities={capabilities}
              edit={(operations, options) => edit(operations, { ...options, scope })}
              close={requestClose}
              dirtyChanged={setDirty}
              t={t}
              {...(version === undefined ? {} : { previewVersion: version.id })}
              {...(generate === undefined
                ? {}
                : {
                  generate: (id: string) => {
                    generate(id, scope)
                  },
                })}
            />
          </aside>
        </div>
      </section>
    </Modal>
  )
}
