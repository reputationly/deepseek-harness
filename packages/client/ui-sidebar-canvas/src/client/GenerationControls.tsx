/** Shared planning and status for media generation requests. */
import { useCallback, useState, type ReactNode } from 'react'
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
    scope?: CanvasScope,
  ) => Promise<MediaPlanView | undefined>
  readonly t: PropsLocale<typeof NS>['t']
}

/** Planning callback and shared status UI for every generation entry point. */
export function useGenerationControls({ scope, planNodes, generateNodes, t }: GenerationControlsProps): {
  readonly generate: (nodes: readonly string[], scope?: CanvasScope) => void
  readonly feedback: ReactNode
  readonly note: string | undefined
} {
  const [note, setNote] = useState<string>()
  const start = useCallback(
    async (nodes: readonly string[], captured?: CanvasScope): Promise<void> => {
      if (generateNodes === undefined) return
      const started =
        captured === undefined ? await generateNodes(nodes) : await generateNodes(nodes, captured)
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
            await start(nodes, captured)
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
  const feedback = (
    <>
      {note === undefined ? undefined : (
        <p className={css.note} role="status">
          {note}
        </p>
      )}
    </>
  )
  return { generate, feedback, note }
}
