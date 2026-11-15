/** Model commands use the editor's local processing, immutable candidates, and managed jobs. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import { LocalMediaEditError, type LocalMediaEditor } from './local-edit.ts'
import type { LocalMediaEditRequest } from './local-edit-types.ts'

/**
 * Register local editing through the same owner used by the canvas applications.
 * @param ctx - plugin context owning the tool registration.
 * @param editor - scoped local editor; no gateway or paid generation is used.
 * @returns nothing; registration follows the plugin lifetime.
 */
export function registerLocalEditTools(ctx: Context, editor: LocalMediaEditor): void {
  ctx.tools.register(defineTool({
    name: 'media_edit',
    description: 'Edit an exact media version locally with FFmpeg. audio_edit trims audio and applies gain and fades; '
      + 'extract_audio makes an audio node from a video; first_frame and last_frame capture images; refresh_tail refreshes the adopted video’s exact-version tail. '
      + 'Read canvas_get first and copy directory, episode, node, and version. Times are milliseconds, volume is linear (0–4). '
      + 'Results are unadopted candidates; use canvas_edit set_version only after the user chooses one. '
      + 'Identical requests reuse their candidate. Local interrupted edits may be explicitly retried; completed files survive failed attachment. No cloud model is called.',
    parameters: {
      directory: { type: 'string', required: true, description: 'Exact project directory from canvas_get.' },
      episode: { type: 'string', required: true, description: 'Captured episode id from canvas_get.' },
      node: { type: 'string', required: true, description: 'Audio or video source node id.' },
      version: { type: 'string', required: true, description: 'Exact retained source version, whether adopted or a candidate.' },
      operation: { type: 'string', required: true, enum: ['audio_edit', 'extract_audio', 'first_frame', 'last_frame', 'refresh_tail'] },
      title: { type: 'string', description: 'Required for extracts and frames: title of their new node.' },
      inMs: { type: 'integer', description: 'Audio trim start; omitted means zero.' },
      outMs: { type: 'integer', description: 'Audio trim end; omitted means the measured source end.' },
      volume: { type: 'number', description: 'Linear audio gain from 0 to 4; omitted means 1.' },
      fadeInMs: { type: 'integer', description: 'Fade in over the edited audio; omitted means zero.' },
      fadeOutMs: { type: 'integer', description: 'Fade out over the edited audio; omitted means zero.' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      node: { type: 'string', required: true }, version: { type: 'string', required: true }, path: { type: 'string', required: true }, reused: { type: 'boolean', required: true },
    } }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('media_edit requires a Session')
      exec.signal.throwIfAborted()
      const source = { scope: { directory: args.directory, episode: brandString<EpisodeId>(args.episode) },
        node: brandString<CanvasNodeId>(args.node), version: brandString<VersionId>(args.version) }
      let request: LocalMediaEditRequest
      if (args.operation === 'audio_edit') request = { ...source, operation: args.operation,
        ...args.inMs === undefined ? {} : { inMs: args.inMs }, ...args.outMs === undefined ? {} : { outMs: args.outMs },
        ...args.volume === undefined ? {} : { volume: args.volume }, ...args.fadeInMs === undefined ? {} : { fadeInMs: args.fadeInMs },
        ...args.fadeOutMs === undefined ? {} : { fadeOutMs: args.fadeOutMs } }
      else {
        if (args.title === undefined) throw new LocalMediaEditError('input', 'Supply a title for the extracted media node')
        request = { ...source, operation: args.operation, title: args.title }
      }
      return editor.edit(exec.agent.session, request)
    },
  }))
}
