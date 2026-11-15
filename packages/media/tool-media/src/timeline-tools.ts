/** Local render tools share the Host jobs, revision fences, and export writer used by the editor. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CanvasNodeId, EpisodeId } from '@deepseek-ai/dsh-canvas/client'
import type { TimelineRenderer } from './timeline-render.ts'

const node = { type: 'string', required: true, description: 'Timeline node id from canvas_get.' } as const
const episode = { type: 'string', required: true, description: 'Episode id from canvas_get; copy it explicitly to keep edits on that episode.' } as const
const directory = { type: 'string', required: true, description: 'Exact project directory from canvas_get.' } as const
const revision = { type: 'integer', required: true, description: 'Current revision returned by timeline_get.' } as const
const viewSchema = { type: 'object', additionalProperties: false, properties: {
  revision: { type: 'integer', required: true },
  state: { type: 'string', required: true, enum: ['stale', 'queued', 'rendering', 'assembling', 'ready', 'cancelled', 'interrupted', 'failed'] },
  progress: { type: 'number', required: true }, jobId: { type: 'string' }, path: { type: 'string' },
  error: { type: 'object', additionalProperties: false, properties: {
    code: { type: 'string', required: true, enum: ['source', 'encoding', 'upload', 'lease', 'probe', 'storage', 'renderer'] },
    message: { type: 'string', required: true },
  } },
} } as const

/**
 * Register model-visible local rendering; none of these operations submit cloud generation.
 * @param ctx - Plugin context owning the tool registrations.
 * @param renderer - Host render lifecycle service used by these tools.
 */
export function registerTimelineRenderTools(ctx: Context, renderer: TimelineRenderer): void {
  ctx.tools.register(defineTool({
    name: 'timeline_render',
    description: 'Build the current timeline full-quality preview with the shared compositor. Read timeline_get first and pass its revision. '
      + 'This queues a local media job; a connected application renders it. queued/rendering/assembling do not mean ready. '
      + 'No cloud model is called. Check timeline_render_status, then timeline_export when ready. Editing invalidates the old preview.',
    parameters: { node, revision, episode, directory },
    output: { schema: viewSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('timeline_render requires a Session')
      exec.signal.throwIfAborted()
      return renderer.start(exec.agent.session, brandString<CanvasNodeId>(args.node), args.revision,
        brandString<EpisodeId>(args.episode), args.directory)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'timeline_render_status',
    description: 'Read the current timeline preview state. Only ready exposes a complete MP4 matching the current revision and pinned source versions. '
      + 'An interrupted job resumes local cache work after reconnect; failed and cancelled are terminal until explicitly retried.',
    parameters: { node, episode, directory },
    output: { schema: viewSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('timeline_render_status requires a Session')
      exec.signal.throwIfAborted()
      return renderer.status(exec.agent.session, brandString<CanvasNodeId>(args.node),
        brandString<EpisodeId>(args.episode), args.directory)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'timeline_export',
    description: 'Export the ready preview bytes as a new immutable video on the canvas. Requires the current timeline revision. '
      + 'The result survives cache cleanup. Existing versions remain unchanged and adopting the exported version is a separate decision.',
    parameters: { node, revision, episode, directory },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      node: { type: 'string', required: true }, path: { type: 'string', required: true }, revision: { type: 'integer', required: true },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('timeline_export requires a Session')
      exec.signal.throwIfAborted()
      return renderer.export(exec.agent.session, brandString<CanvasNodeId>(args.node), args.revision,
        brandString<EpisodeId>(args.episode), 'agent', args.directory)
    },
  }))
}
