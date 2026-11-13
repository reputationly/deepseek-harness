/** The inspector: model, catalog parameters, prompt, references, frames, and versions of one node. */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasDocument, CanvasNode, CanvasOperation } from '@deepseek-ai/dsh-canvas/client'
import type { MediaCapabilityView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  genOperation, modelChoices, operationFor, orderedRefs, paramControls, reorderOperation, type ParamControl,
} from './model/inspector.ts'
import type { NS } from './locales.ts'
import css from './Inspector.module.css'

/** How the inspector is shown. */
export type InspectorPlacement = 'sidebar' | 'drawer'

/** Inputs the inspector needs beyond the selected node. */
export interface InspectorProps {
  readonly document: CanvasDocument
  readonly node: CanvasNode
  readonly placement: InspectorPlacement
  readonly capabilities: (operation: string) => Promise<readonly MediaCapabilityView[]>
  readonly edit: (operations: readonly CanvasOperation[]) => Promise<void>
  /** Local undo/redo generation state; external document refreshes do not change it. */
  readonly historyEpoch?: number
  readonly close: () => void
  readonly openTable?: (nodeId: string) => void
  /** Plans and starts generation for this node through the shared budget flow. */
  readonly generate?: (nodeId: string) => void
  readonly t: PropsLocale<typeof NS>['t']
}

/** Prompt editor of one media node. */
function PromptField({ value, onChange, t }: { value: string; onChange: (next: string) => void; t: InspectorProps['t'] }): ReactNode {
  return <label className={css.field}>
    <span className={css.label}>{t('inspector.prompt')}</span>
    <textarea className={css.textarea} rows={4} value={value} onChange={(event) => { onChange(event.target.value) }} />
  </label>
}

/** One catalog parameter control. */
function ParamField({ control, onChange }: { control: ParamControl; onChange: (next: string) => void }): ReactNode {
  return <label className={css.field}>
    <span className={css.label}>{control.title}</span>
    {control.kind === 'select'
      ? <select className={css.input} value={control.value} onChange={(event) => { onChange(event.target.value) }}>
        {control.options?.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
      : <input className={css.input} type={control.kind === 'number' ? 'number' : 'text'} value={control.value}
        onChange={(event) => { onChange(event.target.value) }} />}
  </label>
}

/**
 * Inspector of one canvas node.
 * @param props - node, catalog, edit call, and copy.
 * @returns the panel with generation, references, frames, versions, and the table entry for storyboards.
 */
export function Inspector({
  document, node, placement, capabilities, edit, historyEpoch = 0, close, openTable, generate, t,
}: InspectorProps): ReactNode {
  const kind = node.gen?.kind
  const [models, setModels] = useState<readonly MediaCapabilityView[]>([])
  const [modelId, setModelId] = useState(node.gen?.model ?? '')
  const [prompt, setPrompt] = useState(node.gen?.prompt ?? '')
  const [params, setParams] = useState<Record<string, string | number | boolean>>({ ...node.gen?.params })
  useEffect(() => {
    setModelId(node.gen?.model ?? '')
    setPrompt(node.gen?.prompt ?? '')
    setParams({ ...node.gen?.params })
    // External reloads keep the user's draft; local history actions reset it.
  }, [node.id, historyEpoch])
  const operation = kind === undefined ? undefined : operationFor(kind)
  useEffect(() => {
    if (operation === undefined) return
    let live = true
    void capabilities(operation).then((found) => { if (live) setModels(found) })
    return () => { live = false }
  }, [operation, capabilities])
  const refs = orderedRefs(document, node.id)
  const first = document.edges.find(edge => edge.target === node.id && edge.role === 'first_frame')?.source
  const last = document.edges.find(edge => edge.target === node.id && edge.role === 'last_frame')?.source
  const chosen = models.find(entry => entry.model === modelId)
  const controls = paramControls(chosen, params)
  const choices = modelChoices(models, first !== undefined || last !== undefined, refs.length > 0)
  const nameOf = (id: string): string => document.nodes.find(candidate => candidate.id === id)?.title ?? id
  const [dragging, setDragging] = useState<number>()
  const apply = (): void => {
    const numeric: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(params)) {
      const control = controls.find(candidate => candidate.id === key)
      const numericText = typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      numeric[key] = control?.kind === 'number' || (control?.kind === 'select' && numericText) ? Number(value) : value
    }
    void edit([genOperation(node, { model: modelId === '' ? undefined : modelId, prompt, params: numeric })])
  }
  return <aside className={clsx(css.root, placement === 'drawer' ? css.drawer : css.sidebar)} aria-label={t('inspector.title')}>
    <header className={css.header}>
      <span className={css.title} title={node.title}>{node.title}</span>
      <Button size="sm" aria-label={t('inspector.close')} onClick={close}>×</Button>
    </header>
    {kind !== undefined && <section className={css.section}>
      <span className={css.sectionTitle}>{t('inspector.generate')}</span>
      <label className={css.field}>
        <span className={css.label}>{t('inspector.model')}</span>
        <select className={css.input} value={modelId} onChange={(event) => { setModelId(event.target.value) }}>
          <option value="">{t('inspector.modelDefault')}</option>
          {choices.map(choice => <option key={choice.id} value={choice.model} disabled={choice.disabled}>{choice.model}</option>)}
        </select>
      </label>
      {controls.map(control => <ParamField key={control.id} control={control}
        onChange={(next) => { setParams(current => ({ ...current, [control.id]: next })) }} />)}
      <PromptField value={prompt} onChange={setPrompt} t={t} />
      <Button variant="primary" size="sm" onClick={apply}>{t('inspector.apply')}</Button>
    </section>}
    {generate === undefined || !['image', 'video', 'audio', 'storyboard', 'timeline'].includes(node.type) ? undefined
      : <section className={css.section}>
        <Button variant="outline" size="sm" onClick={() => { generate(node.id) }}>{t('inspector.generateNow')}</Button>
      </section>}
    {node.type === 'storyboard' && <section className={css.section}>
      <Button variant="outline" size="sm" onClick={() => { openTable?.(node.id) }}>{t('inspector.openTable')}</Button>
    </section>}
    {(node.type === 'image' || node.type === 'video') && <section className={css.section}>
      <span className={css.sectionTitle}>{t('inspector.references')}</span>
      {refs.length === 0
        ? <p className={css.empty}>{t('inspector.noReferences')}</p>
        : <ol className={css.refs}>
          {refs.map((ref, index) => <li key={ref.source} className={css.refRow} draggable
            onDragStart={() => { setDragging(index) }}
            onDragOver={(event) => { event.preventDefault() }}
            onDrop={() => {
              if (dragging === undefined || dragging === index) return
              const order = refs.map(entry => entry.source)
              const [moved] = order.splice(dragging, 1)
              /* v8 ignore next -- splice returns the element it removed, so the guard never fails */
              if (moved !== undefined) order.splice(index, 0, moved)
              setDragging(undefined)
              void edit([reorderOperation(node.id, order)])
            }}>
            <span className={css.refIndex}>{index + 1}</span>
            <span className={css.refName}>{nameOf(ref.source)}</span>
            <Button size="sm" aria-label={t('inspector.removeReference')}
              onClick={() => { void edit([{ op: 'disconnect', from: ref.source, to: node.id, role: 'ref' }]) }}>×</Button>
          </li>)}
        </ol>}
      {node.type === 'video' && <div className={css.frames}>
        {(['first_frame', 'last_frame'] as const).map((role) => {
          const source = role === 'first_frame' ? first : last
          return <div key={role} className={css.frameRow}>
            <span className={css.label}>{role === 'first_frame' ? t('inspector.firstFrame') : t('inspector.lastFrame')}</span>
            <span className={css.frameName}>{source === undefined ? t('inspector.emptyFrame') : nameOf(source)}</span>
            {source === undefined ? undefined : <Button size="sm" aria-label={t('inspector.clearFrame')}
              onClick={() => { void edit([{ op: 'disconnect', from: source, to: node.id, role }]) }}>×</Button>}
          </div>
        })}
      </div>}
    </section>}
    <section className={css.section}>
      <span className={css.sectionTitle}>{t('inspector.versions')}</span>
      <ol className={css.versions}>
        {(node.versions ?? []).map((version, index) => <li key={version.id} className={css.versionRow}>
          <span className={css.versionLabel}>{t('inspector.versionLabel', { n: index + 1 })}</span>
          <span className={css.versionModel}>{version.model ?? version.origin}</span>
          <Button size="sm" disabled={version.id === node.activeVersion}
            onClick={() => { void edit([{ op: 'set_version', node: node.id, version: version.id }]) }}>{t('inspector.useVersion')}</Button>
        </li>)}
      </ol>
    </section>
  </aside>
}
