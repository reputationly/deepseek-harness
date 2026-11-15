/** Agent editing commands use the same timeline writer as the visual editor. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ParameterSchemaSpec, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { CanvasService } from './index.ts'
import type { CanvasNodeId, EpisodeId } from './types.ts'
import type { TimelineOperation } from './timeline-types.ts'

const text = { type: 'string' as const }
const integer = { type: 'integer' as const }
const decimal = { type: 'number' as const }
const specSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    width: { ...integer, required: true },
    height: { ...integer, required: true },
    fps: { ...integer, enum: [24, 25, 30], required: true },
  },
} as const
const clipProperties = {
  id: { ...text, required: true },
  startMs: { ...integer, required: true },
  durationMs: { ...integer, required: true },
  source: {
    type: 'object',
    additionalProperties: false,
    properties: {
      node: { ...text, required: true },
      version: { ...text, required: true },
      inMs: { ...integer, required: true },
    },
  },
  text: {
    type: 'object',
    additionalProperties: false,
    properties: {
      content: { ...text, required: true },
      position: { ...text, enum: ['top', 'center', 'bottom'], required: true },
      size: { ...integer, required: true },
      color: text,
      strokeColor: text,
      strokeWidth: decimal,
      fontFamily: text,
      lineHeight: decimal,
    },
  },
  volume: decimal,
  opacity: decimal,
  fadeInMs: integer,
  fadeOutMs: integer,
  fit: { ...text, enum: ['contain', 'cover'] },
  transform: {
    type: 'object',
    additionalProperties: false,
    properties: {
      x: { ...decimal, required: true },
      y: { ...decimal, required: true },
      width: { ...integer, required: true },
      height: { ...integer, required: true },
      rotation: { ...decimal, required: true },
    },
  },
  still: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        ...text,
        enum: ['static', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down'],
        required: true,
      },
      strength: { ...decimal, required: true },
    },
  },
  transitionIn: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { ...text, enum: ['cut', 'dissolve', 'fade_black'], required: true },
      durationMs: { ...integer, required: true },
    },
  },
} as const
const clipSchema = { type: 'object', additionalProperties: false, properties: clipProperties } as const
const trackSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { ...text, required: true },
    kind: { ...text, enum: ['video', 'audio', 'text'], required: true },
    muted: { type: 'boolean', required: true },
    volume: { ...decimal, required: true },
    clips: { type: 'array', items: clipSchema, required: true },
  },
} as const
const timelineSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { ...integer, const: 1, required: true },
    revision: { ...integer, required: true },
    spec: { ...specSchema, required: true },
    tracks: { type: 'array', items: trackSchema, required: true },
    history: { type: 'object', additionalProperties: false, properties: { undo: integer, redo: integer } },
  },
} as const
function command(op: TimelineOperation['op'], properties: ParameterSchemaSpec): ValueSchemaSpec {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { op: { ...text, const: op, required: true }, ...properties },
  }
}
const track = { ...text, required: true as const, description: 'Track id such as t1.' }
const clip = { ...text, required: true as const, description: 'Clip id such as k1, unique across all tracks.' }
const commandSchema = {
  oneOf: [
    command('add_track', { track: { ...trackSchema, required: true } }),
    command('remove_track', { track }),
    command('set_track', { track, muted: { type: 'boolean' }, volume: decimal }),
    command('add_clip', { track, clip: { ...clipSchema, required: true } }),
    command('move_clip', { track, clip, startMs: { ...integer, required: true } }),
    command('trim_clip', { clip, inMs: { ...integer, required: true }, durationMs: { ...integer, required: true } }),
    command('split_clip', { clip, atMs: { ...integer, required: true }, rightId: { ...text, required: true } }),
    command('remove_clip', { clip }),
    command('ripple_delete', { clip }),
    command('set_clip', {
      clip,
      patch: {
        type: 'object',
        additionalProperties: false,
        required: true,
        properties: Object.fromEntries(
          Object.entries(clipProperties)
            .filter(([key]) => key !== 'id')
            .map(([key, value]) => {
              const { required: _required, ...schema } = value as ValueSchemaSpec & { required?: boolean }
              return [key, schema]
            }),
        ),
      },
    }),
    command('set_spec', { spec: { ...specSchema, required: true } }),
  ],
} as const

/**
 * Register scoped, replayable tools; the generic tool card shows ids and the committed revision.
 * @param ctx - Plugin context owning the tool registrations.
 * @param canvas - Canvas service enforcing shared edits, revision checks, and project bindings.
 */
export function registerTimelineTools(ctx: Context, canvas: CanvasService): void {
  ctx.tools.register(
    defineTool({
      name: 'timeline_history',
      description:
        'List saved timeline revisions, newest first. undo and redo name available cursor targets. Restoration creates a new revision and preserves older generations.',
      parameters: {
        node: { ...text, required: true },
        episode: { ...text, required: true },
        directory: { ...text, required: true },
      },
      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              revision: { ...integer, required: true },
              spec: { ...specSchema, required: true },
              tracks: { ...integer, required: true },
              clips: { ...integer, required: true },
              durationMs: { ...integer, required: true },
              undo: integer,
              redo: integer,
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('timeline_history requires a Session')
        exec.signal.throwIfAborted()
        return [
          ...(await canvas.timelineHistory(
            exec.agent.session,
            brandString<CanvasNodeId>(args.node),
            brandString<EpisodeId>(args.episode),
            args.directory,
          )),
        ]
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'timeline_restore',
      description:
        'Restore a saved revision, or follow the current undo/redo target from timeline_history. Pass the reviewed live baseRevision. Conflicts refuse the whole operation; reread and review before trying again.',
      parameters: {
        node: { ...text, required: true },
        episode: { ...text, required: true },
        directory: { ...text, required: true },
        revision: { ...integer, required: true },
        baseRevision: { ...integer, required: true },
        mode: { ...text, enum: ['restore', 'undo', 'redo'], required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { revision: { ...integer, required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('timeline_restore requires a Session')
        exec.signal.throwIfAborted()
        const result = await canvas.restoreTimeline(
          exec.agent.session,
          brandString<CanvasNodeId>(args.node),
          args.revision,
          args.baseRevision,
          args.mode,
          brandString<EpisodeId>(args.episode),
          args.directory,
        )
        return { revision: result.document.revision }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'timeline_get',
      description:
        'Read a timeline node before editing it. Clips pin specific source versions. Times are integer milliseconds; ' +
        'video and text layers paint in track order. An uninitialized timeline needs an explicit output spec on its first edit.',
      parameters: {
        node: { ...text, required: true },
        episode: { ...text, required: true },
        directory: { ...text, required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { ...integer, required: true },
            document: timelineSchema,
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('timeline_get requires a Session')
        exec.signal.throwIfAborted()
        const document = await canvas.timeline(
          exec.agent.session,
          brandString<CanvasNodeId>(args.node),
          brandString<EpisodeId>(args.episode),
          args.directory,
        )
        return document === undefined
          ? { revision: 0 }
          : {
            revision: document.revision,
            document: { ...document, tracks: document.tracks.map(t => ({ ...t, clips: [...t.clips] })) },
          }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'timeline_edit',
      description:
        'Edit a timeline using the same commands as the visual editor. Read timeline_get first and pass its revision; ' +
        'a conflict refuses the complete batch. Reread and revise the intended changes instead of retrying an old snapshot. ' +
        'Create the timeline node with canvas_edit. On first edit pass spec and add_track; then add_clip with pinned node/version ' +
        'or text. startMs is position in the timeline; source.inMs is position in the media. ripple_delete shifts later clips ' +
        'on that track only. set_clip replaces the supplied fields, and times must stay within source media duration.',
      parameters: {
        node: { ...text, required: true },
        episode: { ...text, required: true },
        directory: { ...text, required: true },
        baseRevision: { ...integer, required: true },
        spec: specSchema,
        operations: { type: 'array', required: true, items: commandSchema },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { ...integer, required: true },
            invalidated: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { fromMs: { ...integer, required: true }, toMs: { ...integer, required: true } },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('timeline_edit requires a Session')
        exec.signal.throwIfAborted()
        // The schema checks command structure; the shared executor checks times, ids, and media references.
        const result = await canvas.editTimeline(
          exec.agent.session,
          brandString<CanvasNodeId>(args.node),
          args.operations as TimelineOperation[],
          args.baseRevision,
          args.spec,
          brandString<EpisodeId>(args.episode),
          args.directory,
        )
        return { revision: result.document.revision, invalidated: [...result.invalidated] }
      },
    }),
  )
}
