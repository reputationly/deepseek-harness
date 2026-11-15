/** The inspector: model, catalog parameters, prompt, references, frames, and versions of one node. */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CanvasDocument,
  CanvasNode,
  CanvasNodeId,
  CanvasOperation,
  CanvasScope,
  VersionId,
} from '@deepseek-ai/dsh-canvas/client'
import type { MediaCapabilityView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  frameChoices,
  modelChoices,
  operationFor,
  orderedRefs,
  paramControls,
  reorderOperation,
  type ParamControl,
} from './model/inspector.ts'
import {
  changeGenerationDraft,
  createGenerationDraft,
  displayedGeneration,
  generationDraftEdit,
} from './model/generation-draft.ts'
import type { CanvasSource } from './canvas-source.ts'
import type { NS } from './locales.ts'
import css from './Inspector.module.css'
import { AudioFields } from './AudioFields.tsx'
import { VideoLocalControls, type VideoLocalServices } from './VideoLocalControls.tsx'

/** How the inspector is shown. */
export type InspectorPlacement = 'sidebar' | 'drawer'

/** Inputs the inspector needs beyond the selected node. */
export interface InspectorProps {
  readonly video?: VideoLocalServices
  readonly document: CanvasDocument
  readonly node: CanvasNode
  readonly placement: InspectorPlacement
  readonly capabilities: (operation: string) => Promise<readonly MediaCapabilityView[]>
  readonly edit: CanvasSource['edit']
  /** Local undo/redo generation state; external document refreshes do not change it. */
  readonly historyEpoch?: number
  readonly close: () => void
  readonly embedded?: boolean
  readonly disabled?: boolean
  readonly dirtyChanged?: (dirty: boolean) => void
  readonly previewVersion?: VersionId
  readonly openAudio?: (nodeId: CanvasNodeId) => void
  readonly openTable?: (nodeId: string) => void
  readonly openTimeline?: (nodeId: import('@deepseek-ai/dsh-canvas/client').CanvasNodeId) => void
  /** Plans and starts generation for this node through the shared budget flow. */
  readonly generate?: (nodeId: string, scope?: CanvasScope) => void
  readonly t: PropsLocale<typeof NS>['t']
}

/** Prompt editor of one media node. */
function PromptField({
  value,
  onChange,
  t,
  kind,
}: {
  value: string
  onChange: (next: string) => void
  t: InspectorProps['t']
  kind: NonNullable<CanvasNode['gen']>['kind'] | undefined
}): ReactNode {
  return (
    <label className={css.field}>
      <span className={css.label}>
        {t(kind === 'music' ? 'audio.style' : kind === 'speech' ? 'audio.text' : 'inspector.prompt')}
      </span>
      <textarea
        className={css.textarea}
        rows={4}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
        }}
      />
    </label>
  )
}

/** One catalog parameter control. */
function ParamField({ control, onChange }: { control: ParamControl; onChange: (next: string) => void }): ReactNode {
  return (
    <label className={css.field}>
      <span className={css.label}>{control.title}</span>
      {control.kind === 'select' ? (
        <select
          className={css.input}
          value={control.value}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        >
          {control.options?.map(option => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          className={css.input}
          type={control.kind === 'number' ? 'number' : 'text'}
          value={control.value}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
      )}
    </label>
  )
}

/**
 * Inspector of one canvas node.
 * @param props - node, catalog, edit call, and copy.
 * @returns the panel with generation, references, frames, versions, and the table entry for storyboards.
 */
export function Inspector(props: InspectorProps): ReactNode {
  return <GenerationInspector key={`${props.node.id}:${String(props.historyEpoch ?? 0)}`} {...props} />
}

function GenerationInspector({
  document,
  node,
  placement,
  capabilities,
  edit,
  close,
  openTable,
  openTimeline,
  openAudio,
  generate,
  video,
  t,
  embedded = false,
  disabled = false,
  dirtyChanged,
  previewVersion,
}: InspectorProps): ReactNode {
  const kind = node.gen?.kind
  const [models, setModels] = useState<readonly MediaCapabilityView[]>([])
  const [draft, setDraft] = useState(() => createGenerationDraft(node, document.revision))
  const [saving, setSaving] = useState(false)
  const [applyFailed, setApplyFailed] = useState(false)
  const [catalogFailed, setCatalogFailed] = useState(false)
  const [catalogEpoch, setCatalogEpoch] = useState(0)
  const values = displayedGeneration(draft, node)
  const modelId = values.model ?? ''
  const prompt = values.prompt
  const params = values.params
  const operation = kind === undefined ? undefined : operationFor(kind)
  const audio = kind === 'music' || kind === 'speech'
  useEffect(() => {
    if (operation === undefined) return
    let live = true
    setCatalogFailed(false)
    void capabilities(operation)
      .then((found) => {
        if (live) setModels(found)
      })
      .catch((_error: unknown) => {
        if (live) setCatalogFailed(true)
      })
    return () => {
      live = false
    }
  }, [operation, capabilities, catalogEpoch])
  const refs = orderedRefs(document, node.id)
  const frames = frameChoices(document, node.id)
  const first = document.edges.find(edge => edge.target === node.id && edge.role === 'first_frame')?.source
  const last = document.edges.find(edge => edge.target === node.id && edge.role === 'last_frame')?.source
  const offered = models.filter(entry => entry.operation === operation)
  const chosen = offered.find(entry => entry.model === modelId)
  const controls = paramControls(chosen, params)
  const choices = modelChoices(offered, first !== undefined || last !== undefined, refs.length > 0)
  const nameOf = (id: string): string => document.nodes.find(candidate => candidate.id === id)?.title ?? id
  const [dragging, setDragging] = useState<number>()
  const numeric = { ...draft.value.params }
  for (const [key, value] of Object.entries(numeric)) {
    if (value === draft.base.params[key]) continue
    const control = controls.find(candidate => candidate.id === key)
    const numericText = typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
    numeric[key] = control?.kind === 'number' || (control?.kind === 'select' && numericText) ? Number(value) : value
  }
  const normalized = { ...draft, value: { ...draft.value, params: numeric } }
  const prepared = generationDraftEdit(normalized, node)
  const dirty = Object.keys(prepared.operation.gen).length > 0
  useEffect(() => {
    dirtyChanged?.(dirty)
  }, [dirty, dirtyChanged])
  const selectedVersion =
    node.versions?.find(version => version.id === (previewVersion ?? node.activeVersion)) ?? node.versions?.at(-1)
  const score = selectedVersion?.params?.abc
  const audioEdges = document.edges.filter(
    edge =>
      edge.target === node.id &&
      (edge.role === 'audio' || edge.role === 'source') &&
      document.nodes.some(source => source.id === edge.source && source.type === 'audio'),
  )
  const source = audioEdges[0]?.source
  const referenceChanged = async (next: string): Promise<void> => {
    setSaving(true)
    setApplyFailed(false)
    try {
      const operations: CanvasOperation[] = audioEdges.map(edge => ({
        op: 'disconnect',
        from: edge.source,
        to: node.id,
        ...(edge.role === undefined ? {} : { role: edge.role }),
      }))
      if (next !== '') operations.push({ op: 'connect', from: next, to: node.id, kind: 'reference', role: 'audio' })
      await edit(operations, { baseRevision: document.revision })
    } catch (_error: unknown) {
      setApplyFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const apply = async (overwrite = false): Promise<void> => {
    if (!dirty || (prepared.conflicts.length > 0 && !overwrite)) return
    setSaving(true)
    setApplyFailed(false)
    try {
      await edit([prepared.operation], {
        baseRevision: document.revision,
        onApplied: (_document, _operations, result) => {
          if (result.skipped.length > 0) return
          const saved = displayedGeneration(normalized, node)
          setDraft({ revision: result.revision, base: saved, value: saved })
        },
      })
    } catch (_error: unknown) {
      setApplyFailed(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <aside
      className={clsx(css.root, embedded && css.embedded, placement === 'drawer' ? css.drawer : css.sidebar)}
      aria-label={t('inspector.title')}
    >
      {!embedded && (
        <header className={css.header}>
          <span className={css.title} title={node.title}>
            {node.title}
          </span>
          <Button size="sm" aria-label={t('inspector.close')} onClick={close}>
            ×
          </Button>
        </header>
      )}
      <fieldset className={css.controls} disabled={disabled || saving}>
        {node.type === 'video' && video !== undefined && (
          <VideoLocalControls key={node.id} {...video} node={node} enabled={!disabled} t={t} />
        )}
        {kind !== undefined && (
          <section className={css.section}>
            <span className={css.sectionTitle}>{t('inspector.generate')}</span>
            <label className={css.field}>
              <span className={css.label}>{t('inspector.model')}</span>
              <select
                className={css.input}
                value={modelId}
                onChange={(event) => {
                  setDraft(current =>
                    changeGenerationDraft(
                      current,
                      node,
                      'model',
                      event.target.value === '' ? undefined : event.target.value,
                    ),
                  )
                }}
              >
                <option value="">{t(embedded && audio ? 'audio.model' : 'inspector.modelDefault')}</option>
                {modelId !== '' && !choices.some(choice => choice.model === modelId) ? (
                  <option value={modelId}>{modelId}</option>
                ) : undefined}
                {choices.map(choice => (
                  <option key={choice.id} value={choice.model} disabled={choice.disabled}>
                    {choice.model}
                  </option>
                ))}
              </select>
            </label>
            {audio && catalogFailed && (
              <div className={css.notice} role="alert">
                {t('audio.catalogFailed')}
                <Button
                  size="sm"
                  onClick={() => {
                    setCatalogEpoch(value => value + 1)
                  }}
                >
                  {t('retry')}
                </Button>
              </div>
            )}
            {audio && chosen === undefined && <p className={css.empty}>{t('audio.chooseModel')}</p>}
            {audio && chosen !== undefined ? (
              <AudioFields
                model={chosen}
                params={params}
                t={t}
                {...(typeof score === 'string' ? { score } : {})}
                change={(key, value) => {
                  setDraft(current => changeGenerationDraft(current, node, 'param', value, key))
                }}
              />
            ) : (
              controls.map(control => (
                <ParamField
                  key={control.id}
                  control={control}
                  onChange={(next) => {
                    setDraft(current => changeGenerationDraft(current, node, 'param', next, control.id))
                  }}
                />
              ))
            )}
            {audio && (source !== undefined || /ace[-_]?step|indextts/iu.test(modelId)) && (
              <label className={css.field}>
                <span className={css.label}>{t('audio.reference')}</span>
                <select
                  className={css.input}
                  value={source ?? ''}
                  onChange={(event) => {
                    void referenceChanged(event.target.value)
                  }}
                >
                  <option value="">{t('audio.noReference')}</option>
                  {document.nodes
                    .filter(
                      candidate =>
                        candidate.type === 'audio' &&
                        candidate.id !== node.id &&
                        candidate.versions?.some(version => version.path !== undefined) === true,
                    )
                    .map(candidate => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </option>
                    ))}
                </select>
                <span className={css.empty}>{t('audio.referenceHint')}</span>
              </label>
            )}
            <PromptField
              kind={kind}
              value={prompt}
              onChange={(next) => {
                setDraft(current => changeGenerationDraft(current, node, 'prompt', next))
              }}
              t={t}
            />
            {prepared.conflicts.length === 0 ? undefined : (
              <div className={css.notice} role="alert">
                <span>{t('inspector.conflict')}</span>
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    setDraft(createGenerationDraft(node, document.revision))
                  }}
                >
                  {t('inspector.reloadDraft')}
                </Button>
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    void apply(true)
                  }}
                >
                  {t('inspector.overwriteDraft')}
                </Button>
              </div>
            )}
            {applyFailed ? (
              <p className={css.notice} role="alert">
                {t('inspector.applyFailed')}
              </p>
            ) : undefined}
            <Button
              variant="primary"
              size="sm"
              disabled={saving || !dirty || prepared.conflicts.length > 0}
              onClick={() => {
                void apply()
              }}
            >
              {t('inspector.apply')}
            </Button>
          </section>
        )}
        {generate === undefined ||
        !['image', 'video', 'audio', 'storyboard', 'timeline'].includes(node.type) ? undefined : (
            <section className={css.section}>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  saving ||
                dirty ||
                (audio && catalogFailed) ||
                (embedded && audio && chosen === undefined) ||
                node.status?.state === 'running' ||
                node.status?.state === 'queued' ||
                (node.status?.state === 'failed' && node.status.recoveryRequired === true)
                }
                onClick={() => {
                  generate(node.id)
                }}
              >
                {t('inspector.generateNow')}
              </Button>
              {dirty ? <p className={css.empty}>{t('inspector.applyBeforeGenerate')}</p> : undefined}
            </section>
          )}
        {node.type === 'storyboard' && (
          <section className={css.section}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                openTable?.(node.id)
              }}
            >
              {t('inspector.openTable')}
            </Button>
          </section>
        )}
        {node.type === 'timeline' && (
          <section className={css.section}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                openTimeline?.(node.id)
              }}
            >
              {t('editor.open')}
            </Button>
          </section>
        )}
        {!embedded && audio && (
          <section className={css.section}>
            <Button
              size="sm"
              onClick={() => {
                openAudio?.(node.id)
              }}
            >
              {t('audio.open')}
            </Button>
          </section>
        )}
        {(node.type === 'image' || node.type === 'video') && (
          <section className={css.section}>
            <span className={css.sectionTitle}>{t('inspector.references')}</span>
            {refs.length === 0 ? (
              <p className={css.empty}>{t('inspector.noReferences')}</p>
            ) : (
              <ol className={css.refs}>
                {refs.map((ref, index) => (
                  <li
                    key={ref.source}
                    className={css.refRow}
                    draggable
                    onDragStart={() => {
                      setDragging(index)
                    }}
                    onDragOver={(event) => {
                      event.preventDefault()
                    }}
                    onDrop={() => {
                      if (dragging === undefined || dragging === index) return
                      const order = refs.map(entry => entry.source)
                      const [moved] = order.splice(dragging, 1)
                      /* v8 ignore next -- splice returns the element it removed, so the guard never fails */
                      if (moved !== undefined) order.splice(index, 0, moved)
                      setDragging(undefined)
                      void edit([reorderOperation(node.id, order)])
                    }}
                  >
                    <span className={css.refIndex}>{index + 1}</span>
                    <span className={css.refName}>{nameOf(ref.source)}</span>
                    <Button
                      size="sm"
                      aria-label={t('inspector.removeReference')}
                      onClick={() => {
                        void edit([{ op: 'disconnect', from: ref.source, to: node.id, role: 'ref' }])
                      }}
                    >
                      ×
                    </Button>
                  </li>
                ))}
              </ol>
            )}
            {node.type === 'video' && (
              <div className={css.frames}>
                {(['first_frame', 'last_frame'] as const).map((role) => {
                  const source = role === 'first_frame' ? first : last
                  return (
                    <div key={role} className={css.frameRow}>
                      <span className={css.label}>
                        {role === 'first_frame' ? t('inspector.firstFrame') : t('inspector.lastFrame')}
                      </span>
                      <select
                        className={clsx(css.input, css.frameName)}
                        value={source ?? ''}
                        aria-label={role === 'first_frame' ? t('inspector.firstFrame') : t('inspector.lastFrame')}
                        onChange={(event) => {
                          const next = event.target.value
                          if (next === source) return
                          const operations: CanvasOperation[] =
                            source === undefined ? [] : [{ op: 'disconnect', from: source, to: node.id, role }]
                          if (next !== '')
                            operations.push({ op: 'connect', from: next, to: node.id, kind: 'reference', role })
                          void edit(operations, { baseRevision: document.revision })
                        }}
                      >
                        <option value="">{t('inspector.emptyFrame')}</option>
                        {source !== undefined && !frames.some(frame => frame.id === source) ? (
                          <option value={source} disabled>
                            {nameOf(source)}
                          </option>
                        ) : undefined}
                        {frames.map(frame => (
                          <option key={frame.id} value={frame.id} disabled={frame.disabled}>
                            {frame.title}
                          </option>
                        ))}
                      </select>
                      {source === undefined ? undefined : (
                        <Button
                          size="sm"
                          aria-label={t('inspector.clearFrame')}
                          onClick={() => {
                            void edit([{ op: 'disconnect', from: source, to: node.id, role }], {
                              baseRevision: document.revision,
                            })
                          }}
                        >
                          ×
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )}
        {!embedded && (
          <section className={css.section}>
            <span className={css.sectionTitle}>{t('inspector.versions')}</span>
            <ol className={css.versions}>
              {(node.versions ?? []).map((version, index) => (
                <li key={version.id} className={css.versionRow}>
                  <span className={css.versionLabel}>{t('inspector.versionLabel', { n: index + 1 })}</span>
                  <span className={css.versionModel}>{version.model ?? version.origin}</span>
                  <Button
                    size="sm"
                    disabled={version.id === node.activeVersion}
                    onClick={() => {
                      void edit([{ op: 'set_version', node: node.id, version: version.id }])
                    }}
                  >
                    {t('inspector.useVersion')}
                  </Button>
                </li>
              ))}
            </ol>
          </section>
        )}
      </fieldset>
    </aside>
  )
}
