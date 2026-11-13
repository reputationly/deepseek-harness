/** Shared planning, confirmation, and status for media generation requests. */
import { useCallback, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import type { MediaPlanView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './GenerationControls.module.css'

interface GenerationControlsProps {
  readonly document: CanvasDocument | undefined
  readonly planNodes?: (nodes: readonly string[]) => Promise<MediaPlanView | undefined>
  readonly generateNodes?: (nodes: readonly string[], token: string | undefined) => Promise<MediaPlanView | undefined>
  readonly t: PropsLocale<typeof NS>['t']
}

interface Confirmation {
  readonly plan: MediaPlanView
  readonly nodes: readonly string[]
}

/** Planning callback and shared confirmation/status UI for every generation entry point. */
export function useGenerationControls({ document, planNodes, generateNodes, t }: GenerationControlsProps): {
  readonly generate: (nodes: readonly string[]) => void
  readonly feedback: ReactNode
} {
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [note, setNote] = useState<string>()
  const nameOf = (id: string): string => document?.nodes.find(node => node.id === id)?.title ?? id
  const start = useCallback(async (nodes: readonly string[], token: string | undefined): Promise<void> => {
    if (generateNodes === undefined) return
    const started = await generateNodes(nodes, token)
    if (started?.state === 'needs_confirmation') {
      setNote(t('budget.changed'))
      setConfirmation({ plan: started, nodes })
      return
    }
    setNote(started === undefined ? undefined : t('inspector.started', { count: started.jobs.length }))
  }, [generateNodes, t])
  const generate = useCallback((nodes: readonly string[]): void => {
    if (planNodes === undefined || generateNodes === undefined) return
    setNote(undefined)
    void planNodes(nodes).then(async (planned) => {
      if (planned === undefined) return
      if (planned.state === 'ready') {
        await start(nodes, undefined)
        return
      }
      if (planned.state === 'needs_confirmation') {
        setConfirmation({ plan: planned, nodes })
        return
      }
      setNote(planned.message ?? planned.state)
    }).catch((error: unknown) => { setNote(error instanceof Error ? error.message : String(error)) })
  }, [generateNodes, planNodes, start])
  const confirm = useCallback((plan: MediaPlanView, nodes: readonly string[]): void => {
    setConfirmation(undefined)
    void start(nodes, plan.token).catch((error: unknown) => { setNote(error instanceof Error ? error.message : String(error)) })
  }, [start])
  const feedback = <>
    {note === undefined ? undefined : <p className={css.note} role="status">{note}</p>}
    {confirmation === undefined ? undefined : <div className={css.backdrop} role="presentation">
      <div className={css.dialog} role="dialog" aria-label={t('budget.title')}>
        <span className={css.title}>{t('budget.title')}</span>
        <ul className={css.lines}>
          {confirmation.plan.lines.map(line => <li key={line.node}>
            {t('budget.line', {
              node: nameOf(line.node), kind: line.kind, model: line.model, calls: line.calls,
            })}
          </li>)}
        </ul>
        <span className={css.totals}>{t('budget.totals', {
          video: confirmation.plan.totals.videoCalls, seconds: confirmation.plan.totals.videoSeconds,
          images: confirmation.plan.totals.imageCalls, speech: confirmation.plan.totals.speechLines,
          music: confirmation.plan.totals.musicCalls,
        })}</span>
        <div className={css.actions}>
          <Button size="sm" onClick={() => { setConfirmation(undefined) }}>{t('budget.cancel')}</Button>
          <Button variant="primary" size="sm" onClick={() => { confirm(confirmation.plan, confirmation.nodes) }}>{t('budget.confirm')}</Button>
        </div>
      </div>
    </div>}
  </>
  return { generate, feedback }
}
