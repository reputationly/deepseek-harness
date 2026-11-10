/** Load the flow library only after a canvas with nodes is shown. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { CanvasFlowProps } from './CanvasFlow.tsx'

const LoadedCanvasFlow = lazy(async () => ({ default: (await import('./CanvasFlow.tsx')).CanvasFlow }))

/**
 * Suspend while the package-local flow chunk arrives.
 * @param props - flow props supplied by the canvas body.
 * @returns the deferred flow.
 */
export function LazyCanvasFlow(props: CanvasFlowProps): ReactNode {
  return <Suspense fallback={null}><LoadedCanvasFlow {...props} /></Suspense>
}
