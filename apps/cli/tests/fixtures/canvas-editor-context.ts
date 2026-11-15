/** Publishes one UI selection; the ordinary headless profile owns the Agent and execution. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas'

/** Fixture provider identity. */
export const name = 'canvas-editor-context-fixture'
/** Wait for the public services before observing Agent creation. */
export const inject = ['canvas', 'agents']

/**
 * Supply the same metadata a Client publishes before its next conversation turn.
 * @param ctx - profile-owned services and fixture lifetime.
 * @returns after registering the scoped creation listener.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', ({ agent }) => {
    ctx.canvas.editorContext(agent.session, {
      scope: { directory: ctx.canvas.directoryOf(agent.session), episode: brandString<EpisodeId>('e1') },
      application: 'music', revision: 1, available: true, dirty: true,
      node: brandString<CanvasNodeId>('n1'), version: brandString<VersionId>('v2'),
    })
  })
}
