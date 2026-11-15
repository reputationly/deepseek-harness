/** Shared planning, confirmation, and status for media generation requests. */
import { useCallback, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { CanvasDocument, CanvasScope } from '@deepseek-ai/dsh-canvas/client'
import type { MediaPlanView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './GenerationControls.module.css'

interface GenerationControlsProps {
  readonly document: CanvasDocument | undefined
  readonly scope?: CanvasScope
  readonly planNodes?: (nodes: readonly string[], scope?: CanvasScope) => Promise<MediaPlanView | undefined>
  readonly generateNodes?: (
    nodes: readonly string[],
    token: string | undefined,
    scope?: CanvasScope,
  ) => Promise<MediaPlanView | undefined>
  readonly t: PropsLocale<typeof NS>['t']
}

interface Confirmation {
  readonly plan: MediaPlanView
  readonly nodes: readonly string[]
  readonly scope?: CanvasScope
}

/** Planning callback and shared confirmation/status UI for every generation entry point. */
export function useGenerationControls({ document, scope, planNodes, generateNodes, t }: GenerationControlsProps): {
  readonly generate: (nodes: readonly string[], scope?: CanvasScope) => void
  readonly feedback: ReactNode
  readonly note: string | undefined
} {
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [note, setNote] = useState<string>()
  const nameOf = (id: string): string => document?.nodes.find(node => node.id === id)?.title ?? id
  const start = useCallback(
    async (nodes: readonly string[], token: string | undefined, captured?: CanvasScope): Promise<void> => {
      if (generateNodes === undefined) return
      const started =
        captured === undefined ? await generateNodes(nodes, token) : await generateNodes(nodes, token, captured)
      if (started?.state === 'needs_confirmation') {
        setNote(t('budget.changed'))
        setConfirmation({ plan: started, nodes, ...(captured === undefined ? {} : { scope: captured }) })
        return
      }
      setNote(
        started === undefined
          ? undefined
          : started.state === 'started'
            ? t('inspector.started', { count: started.jobs.length })
            : t('audio.notStarted', { message: started.message ?? started.state }),
      )
    },
    [generateNodes, t],
  )
  const generate = useCallback(
    (nodes: readonly string[], captured = scope): void => {
      if (planNodes === undefined || generateNodes === undefined) return
      setNote(undefined)
      const planning = captured === undefined ? planNodes(nodes) : planNodes(nodes, captured)
      void planning
        .then(async (planned) => {
          if (planned === undefined) return
          if (planned.state === 'ready') {
            await start(nodes, undefined, captured)
            return
          }
          if (planned.state === 'needs_confirmation') {
            setConfirmation({ plan: planned, nodes, ...(captured === undefined ? {} : { scope: captured }) })
            return
          }
          setNote(planned.message ?? planned.state)
        })
        .catch((error: unknown) => {
          setNote(error instanceof Error ? error.message : String(error))
        })
    },
    [generateNodes, planNodes, scope, start],
  )
  const currentConfirmation =
    confirmation?.scope === undefined ||
    (scope !== undefined &&
      confirmation.scope.directory === scope.directory &&
      confirmation.scope.episode === scope.episode)
  const confirm = useCallback(
    (plan: MediaPlanView, nodes: readonly string[], captured?: CanvasScope): void => {
      setConfirmation(undefined)
      void start(nodes, plan.token, captured).catch((error: unknown) => {
        setNote(error instanceof Error ? error.message : String(error))
      })
    },
    [start],
  )
  const feedback = (
    <>
      {note === undefined ? undefined : (
        <p className={css.note} role="status">
          {note}
        </p>
      )}
      {confirmation === undefined ? undefined : (
        <Modal
          open
          headless
          title={t('budget.title')}
          className={clsx(css.dialog)}
          onClose={() => {
            setConfirmation(undefined)
          }}
        >
          <span className={css.title}>{t('budget.title')}</span>
          {!currentConfirmation && <p role="alert">{t('canvas.scopeChanged')}</p>}
          <ul className={css.lines}>
            {confirmation.plan.lines.map(line => (
              <li key={line.node}>
                {t('budget.line', {
                  node: nameOf(line.node),
                  kind: line.kind,
                  model: line.model,
                  calls: line.calls,
                })}
              </li>
            ))}
          </ul>
          <span className={css.totals}>
            {t('budget.totals', {
              video: confirmation.plan.totals.videoCalls,
              seconds: confirmation.plan.totals.videoSeconds,
              images: confirmation.plan.totals.imageCalls,
              speech: confirmation.plan.totals.speechLines,
              music: confirmation.plan.totals.musicCalls,
            })}
          </span>
          <div className={css.actions}>
            <Button
              size="sm"
              onClick={() => {
                setConfirmation(undefined)
              }}
            >
              {t('budget.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!currentConfirmation}
              onClick={() => {
                confirm(confirmation.plan, confirmation.nodes, confirmation.scope)
              }}
            >
              {t('budget.confirm')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
  return { generate, feedback, note }
}
