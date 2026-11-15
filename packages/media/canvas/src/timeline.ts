/** Parsing and pure editing of timeline documents. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { CanvasCorruptError, CanvasUnsupportedVersionError } from './document.ts'
import { CanvasConflictError } from './errors.ts'
import type {
  Timeline,
  TimelineClip,
  TimelineEditResult,
  TimelineOperation,
  TimelineTrack,
  TimelineTrackId,
} from './timeline-types.ts'
import type { CanvasNodeId, StillMotion, TimelineClipId, VersionId } from './types.ts'

function fail(reason: string): never {
  throw new CanvasCorruptError(`timeline: ${reason}`)
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('expected an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) if (!fields.includes(key)) fail(`unknown field ${key}`)
  return record
}
function number(value: unknown, min = 0, integer = true): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    (integer && !Number.isSafeInteger(value))
  ) {
    return fail(`expected ${integer ? 'a safe integer' : 'a number'} >= ${String(min)}`)
  }
  return value
}
function string(value: unknown): string {
  if (typeof value !== 'string') return fail('expected a string')
  return value
}
function id(value: unknown, prefix: string): string {
  const result = string(value)
  if (!new RegExp(`^${prefix}[1-9][0-9]*$`).test(result)) fail(`invalid ${prefix} id`)
  return result
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  const found = choices.find(choice => choice === value)
  if (found === undefined) return fail(`expected one of ${choices.join(', ')}`)
  return found
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return fail('expected an array')
  return value
}
function volume(value: unknown): number {
  return number(value, 0, false)
}
function color(value: unknown): string {
  const result = string(value)
  if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(result)) fail('color must be #RRGGBB or #RRGGBBAA')
  return result
}

function clipOf(value: unknown): TimelineClip {
  const c = object(value, [
    'id',
    'startMs',
    'durationMs',
    'source',
    'text',
    'still',
    'volume',
    'fadeInMs',
    'fadeOutMs',
    'opacity',
    'fit',
    'transform',
    'transitionIn',
  ])
  const clip: TimelineClip = {
    id: brandString<TimelineClipId>(id(c.id, 'k')),
    startMs: number(c.startMs),
    durationMs: number(c.durationMs, 1),
    ...(c.source === undefined
      ? {}
      : {
        source: (() => {
          const s = object(c.source, ['node', 'version', 'inMs'])
          return {
            node: brandString<CanvasNodeId>(id(s.node, 'n')),
            version: brandString<VersionId>(string(s.version)),
            inMs: number(s.inMs),
          }
        })(),
      }),
    ...(c.text === undefined
      ? {}
      : {
        text: (() => {
          const t = object(c.text, [
            'content',
            'position',
            'size',
            'color',
            'strokeColor',
            'strokeWidth',
            'fontFamily',
            'lineHeight',
          ])
          return {
            content: string(t.content),
            position: oneOf(t.position, ['top', 'center', 'bottom'] as const),
            size: number(t.size, 1),
            ...(t.color === undefined ? {} : { color: color(t.color) }),
            ...(t.strokeColor === undefined ? {} : { strokeColor: color(t.strokeColor) }),
            ...(t.strokeWidth === undefined ? {} : { strokeWidth: number(t.strokeWidth, 0, false) }),
            ...(t.fontFamily === undefined ? {} : { fontFamily: string(t.fontFamily) }),
            ...(t.lineHeight === undefined ? {} : { lineHeight: number(t.lineHeight, 1, false) }),
          }
        })(),
      }),
    ...(c.still === undefined
      ? {}
      : {
        still: (() => {
          const s = object(c.still, ['type', 'strength'])
          const strength = number(s.strength, 0, false)
          if (strength > 1) fail('motion strength exceeds 1')
          return {
            type: oneOf<StillMotion['type']>(s.type, [
              'static',
              'zoom_in',
              'zoom_out',
              'pan_left',
              'pan_right',
              'pan_up',
              'pan_down',
            ]),
            strength,
          }
        })(),
      }),
    ...(c.volume === undefined ? {} : { volume: volume(c.volume) }),
    ...(c.fadeInMs === undefined ? {} : { fadeInMs: number(c.fadeInMs) }),
    ...(c.fadeOutMs === undefined ? {} : { fadeOutMs: number(c.fadeOutMs) }),
    ...(c.opacity === undefined ? {} : { opacity: number(c.opacity, 0, false) }),
    ...(c.fit === undefined ? {} : { fit: oneOf(c.fit, ['contain', 'cover'] as const) }),
    ...(c.transform === undefined
      ? {}
      : {
        transform: (() => {
          const t = object(c.transform, ['x', 'y', 'width', 'height', 'rotation'])
          return {
            x: number(t.x, -Number.MAX_VALUE, false),
            y: number(t.y, -Number.MAX_VALUE, false),
            width: number(t.width, 1),
            height: number(t.height, 1),
            rotation: number(t.rotation, -Number.MAX_VALUE, false),
          }
        })(),
      }),
    ...(c.transitionIn === undefined
      ? {}
      : {
        transitionIn: (() => {
          const t = object(c.transitionIn, ['type', 'durationMs'])
          return { type: oneOf(t.type, ['cut', 'dissolve', 'fade_black'] as const), durationMs: number(t.durationMs) }
        })(),
      }),
  }
  if (!Number.isSafeInteger(clip.startMs + clip.durationMs)) fail('clip end exceeds safe time range')
  if (clip.source !== undefined && !Number.isSafeInteger(clip.source.inMs + clip.durationMs))
    fail('source end exceeds safe time range')
  if ((clip.opacity ?? 1) > 1) fail('opacity exceeds 1')
  for (const fade of [clip.fadeInMs, clip.fadeOutMs, clip.transitionIn?.durationMs]) {
    if (fade !== undefined && fade > clip.durationMs) fail('fade or transition exceeds clip duration')
  }
  return clip
}

/**
 * Validate durable JSON without repairing or dropping invalid fields.
 * @param source - Serialized timeline document to validate.
 * @returns The validated document.
 */
export function parseTimeline(source: string): Timeline {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error: unknown) {
    throw new CanvasCorruptError(`timeline: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = object(value, ['version', 'revision', 'spec', 'tracks', 'history'])
  if (typeof root.version === 'number' && root.version > 1) throw new CanvasUnsupportedVersionError(root.version)
  if (root.version !== 1) fail('unsupported timeline format')
  const spec = object(root.spec, ['width', 'height', 'fps'])
  const width = number(spec.width, 2),
    height = number(spec.height, 2)
  if (width % 2 !== 0 || height % 2 !== 0) fail('output dimensions must be even')
  const fps = spec.fps === 24 || spec.fps === 25 || spec.fps === 30 ? spec.fps : fail('unsupported frame rate')
  const ids = new Set<string>(),
    clips = new Set<string>()
  const tracks = list(root.tracks).map((value): TimelineTrack => {
    const t = object(value, ['id', 'kind', 'muted', 'volume', 'clips'])
    const trackId = id(t.id, 't')
    if (ids.has(trackId)) fail(`duplicate track ${trackId}`)
    ids.add(trackId)
    const kind = oneOf(t.kind, ['video', 'audio', 'text'] as const)
    if (typeof t.muted !== 'boolean') return fail('track.muted must be boolean')
    return {
      id: brandString<TimelineTrackId>(trackId),
      kind,
      muted: t.muted,
      volume: volume(t.volume),
      clips: list(t.clips).map((value) => {
        const clip = clipOf(value)
        if (clips.has(clip.id)) fail(`duplicate clip ${clip.id}`)
        clips.add(clip.id)
        if (
          kind === 'text'
            ? clip.text === undefined || clip.source !== undefined
            : clip.source === undefined || clip.text !== undefined
        ) {
          fail(`clip ${clip.id} does not match ${kind} track`)
        }
        return clip
      }),
    }
  })
  const revision = number(root.revision)
  const history = root.history === undefined ? undefined : object(root.history, ['undo', 'redo'])
  const links: { undo?: number; redo?: number } = {}
  for (const field of ['undo', 'redo'] as const)
    if (history?.[field] !== undefined) {
      const link = number(history[field], 1)
      if (link >= revision) fail('history link must precede its revision')
      links[field] = link
    }
  return {
    version: 1,
    revision,
    spec: { width, height, fps },
    tracks,
    ...(history === undefined ? {} : { history: links }),
  }
}

/**
 * Duration includes the tail of every track, including text and audio.
 * @param timeline - Validated timeline being evaluated.
 * @returns The greatest clip end in milliseconds, or zero for an empty timeline.
 */
export function timelineDuration(timeline: Timeline): number {
  return timeline.tracks.reduce(
    (max, track) => track.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), max),
    0,
  )
}

/**
 * Apply a batch atomically; a rejected command leaves the supplied document unchanged.
 * @param document - Validated timeline before the edit or sample calculation.
 * @param operations - Ordered shared timeline commands, committed atomically.
 * @param baseRevision - Document revision the caller read before preparing the operation batch.
 * @returns The revised document and affected output intervals.
 */
export function applyTimeline(
  document: Timeline,
  operations: readonly TimelineOperation[],
  baseRevision: number,
): TimelineEditResult {
  if (baseRevision !== document.revision) throw new CanvasConflictError(baseRevision, document.revision)
  let next = document
  const ranges: { fromMs: number; toMs: number }[] = []
  const dirty = (c: TimelineClip): void => {
    ranges.push({ fromMs: c.startMs, toMs: c.startMs + c.durationMs })
  }
  const track = (id: string): TimelineTrack =>
    next.tracks.find(t => t.id === id) ?? fail(`track ${id} does not exist`)
  const locate = (id: string): { track: TimelineTrack; clip: TimelineClip } => {
    for (const t of next.tracks) {
      const clip = t.clips.find(c => c.id === id)
      if (clip !== undefined) return { track: t, clip }
    }
    return fail(`clip ${id} does not exist`)
  }
  const replace = (id: string, change: (t: TimelineTrack) => TimelineTrack): void => {
    track(id)
    next = { ...next, tracks: next.tracks.map(t => (t.id === id ? change(t) : t)) }
  }
  for (const operation of operations) {
    switch (operation.op) {
      case 'add_track':
        if (next.tracks.some(t => t.id === operation.track.id)) fail('track already exists')
        next = { ...next, tracks: [...next.tracks, operation.track] }
        operation.track.clips.forEach(dirty)
        break
      case 'remove_track':
        track(operation.track).clips.forEach(dirty)
        next = { ...next, tracks: next.tracks.filter(t => t.id !== operation.track) }
        break
      case 'set_track':
        track(operation.track).clips.forEach(dirty)
        replace(operation.track, t => ({
          ...t,
          ...(operation.muted === undefined ? {} : { muted: operation.muted }),
          ...(operation.volume === undefined ? {} : { volume: operation.volume }),
        }))
        break
      case 'set_spec':
        ranges.push({ fromMs: 0, toMs: timelineDuration(next) })
        next = { ...next, spec: operation.spec }
        break
      case 'add_clip':
        dirty(operation.clip)
        replace(operation.track, t => ({ ...t, clips: [...t.clips, operation.clip] }))
        break
      case 'move_clip': {
        const held = locate(operation.clip)
        const moved = { ...held.clip, startMs: operation.startMs }
        dirty(held.clip)
        dirty(moved)
        replace(held.track.id, t => ({ ...t, clips: t.clips.filter(c => c.id !== operation.clip) }))
        replace(operation.track, t => ({ ...t, clips: [...t.clips, moved] }))
        break
      }
      case 'trim_clip':
      case 'set_clip': {
        const held = locate(operation.clip)
        const patch =
          operation.op === 'set_clip'
            ? operation.patch
            : {
              durationMs: operation.durationMs,
              ...(held.clip.source === undefined ? {} : { source: { ...held.clip.source, inMs: operation.inMs } }),
            }
        const edited = { ...held.clip, ...patch }
        dirty(held.clip)
        dirty(edited)
        replace(held.track.id, t => ({ ...t, clips: t.clips.map(c => (c.id === held.clip.id ? edited : c)) }))
        break
      }
      case 'split_clip': {
        const held = locate(operation.clip),
          leftDuration = operation.atMs - held.clip.startMs
        if (leftDuration <= 0 || leftDuration >= held.clip.durationMs) fail('split must be inside the clip')
        const left = {
          ...held.clip,
          durationMs: leftDuration,
          fadeInMs: Math.min(held.clip.fadeInMs ?? 0, leftDuration),
          fadeOutMs: 0,
          ...(held.clip.transitionIn === undefined
            ? {}
            : {
              transitionIn: {
                ...held.clip.transitionIn,
                durationMs: Math.min(held.clip.transitionIn.durationMs, leftDuration),
              },
            }),
        }
        const rightDuration = held.clip.durationMs - leftDuration
        const right = {
          ...held.clip,
          id: operation.rightId,
          startMs: operation.atMs,
          durationMs: rightDuration,
          fadeInMs: 0,
          fadeOutMs: Math.min(held.clip.fadeOutMs ?? 0, rightDuration),
          transitionIn: { type: 'cut' as const, durationMs: 0 },
          ...(held.clip.source === undefined
            ? {}
            : { source: { ...held.clip.source, inMs: held.clip.source.inMs + leftDuration } }),
        }
        dirty(held.clip)
        replace(held.track.id, t => ({
          ...t,
          clips: t.clips.flatMap(c => (c.id === held.clip.id ? [left, right] : [c])),
        }))
        break
      }
      case 'remove_clip':
      case 'ripple_delete': {
        const held = locate(operation.clip)
        dirty(held.clip)
        replace(held.track.id, t => ({
          ...t,
          clips: t.clips
            .filter(c => c.id !== held.clip.id)
            .map((c) => {
              if (operation.op !== 'ripple_delete' || c.startMs < held.clip.startMs + held.clip.durationMs) return c
              const shifted = { ...c, startMs: c.startMs - held.clip.durationMs }
              dirty(c)
              dirty(shifted)
              return shifted
            }),
        }))
        break
      }
      default: {
        const unknown: never = operation
        throw new Error(`unknown timeline command ${String(unknown)}`)
      }
    }
    // Each intermediate document must be representable; invalid commands cannot be hidden by later ones.
    next = parseTimeline(JSON.stringify(next))
  }
  const invalidated: { fromMs: number; toMs: number }[] = []
  for (const range of ranges.sort((a, b) => a.fromMs - b.fromMs)) {
    if (range.fromMs === range.toMs) continue
    const last = invalidated.at(-1)
    if (last !== undefined && range.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, range.toMs)
    else invalidated.push({ ...range })
  }
  return { document: operations.length === 0 ? document : { ...next, revision: document.revision + 1 }, invalidated }
}
