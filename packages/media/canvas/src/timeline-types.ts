/** Immutable editing document shared by the Host, editor, and media renderer. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CanvasNodeId, StillMotion, TimelineClipId, VersionId } from './types.ts'

/** Track identity within one timeline. */
export type TimelineTrackId = Branded<'TimelineTrackId'>

/** A pinned input; changing the node's active version does not change this reference. */
export interface TimelineSource {
  readonly node: CanvasNodeId
  readonly version: VersionId
  readonly inMs: number
}

/** A timed layer. Coordinates and text size are measured in output pixels. */
export interface TimelineClip {
  readonly id: TimelineClipId
  readonly startMs: number
  readonly durationMs: number
  readonly source?: TimelineSource
  readonly text?: {
    readonly content: string
    readonly position: 'top' | 'center' | 'bottom'
    readonly size: number
    readonly color?: string
    readonly strokeColor?: string
    readonly strokeWidth?: number
    readonly fontFamily?: string
    readonly lineHeight?: number
  }
  readonly still?: StillMotion
  readonly volume?: number
  readonly fadeInMs?: number
  readonly fadeOutMs?: number
  readonly opacity?: number
  readonly fit?: 'contain' | 'cover'
  readonly transform?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    readonly rotation: number
  }
  readonly transitionIn?: { readonly type: 'cut' | 'dissolve' | 'fade_black'; readonly durationMs: number }
}

/** Tracks are painted in array order, with later video and text tracks above earlier tracks. */
export interface TimelineTrack {
  readonly id: TimelineTrackId
  readonly kind: 'video' | 'audio' | 'text'
  readonly muted: boolean
  readonly volume: number
  readonly clips: readonly TimelineClip[]
}

/** Independently revisioned file beside the canvas; all edits commit one complete document. */
export interface Timeline {
  readonly version: 1
  readonly revision: number
  readonly spec: { readonly width: number; readonly height: number; readonly fps: 24 | 25 | 30 }
  readonly tracks: readonly TimelineTrack[]
  /** Host-owned undo/redo links; absent on older documents, whose predecessor is the prior saved revision. */
  readonly history?: { readonly undo?: number; readonly redo?: number }
}

/** Commands used by both editor gestures and the editing tools. */
export type TimelineOperation =
  | { readonly op: 'add_track'; readonly track: TimelineTrack }
  | { readonly op: 'remove_track'; readonly track: TimelineTrackId }
  | { readonly op: 'set_track'; readonly track: TimelineTrackId; readonly muted?: boolean; readonly volume?: number }
  | { readonly op: 'add_clip'; readonly track: TimelineTrackId; readonly clip: TimelineClip }
  | { readonly op: 'move_clip'; readonly clip: TimelineClipId; readonly track: TimelineTrackId; readonly startMs: number }
  | { readonly op: 'trim_clip'; readonly clip: TimelineClipId; readonly inMs: number; readonly durationMs: number }
  | { readonly op: 'split_clip'; readonly clip: TimelineClipId; readonly atMs: number; readonly rightId: TimelineClipId }
  | { readonly op: 'remove_clip'; readonly clip: TimelineClipId }
  | { readonly op: 'ripple_delete'; readonly clip: TimelineClipId }
  | { readonly op: 'set_clip'; readonly clip: TimelineClipId; readonly patch: Partial<Omit<TimelineClip, 'id'>> }
  | { readonly op: 'set_spec'; readonly spec: Timeline['spec'] }

/** An edited document and the union of intervals whose cached content may have changed. */
export interface TimelineEditResult {
  readonly document: Timeline
  readonly invalidated: readonly { readonly fromMs: number; readonly toMs: number }[]
}

/** Saved revision available for explicit restoration; restoring creates a new live revision. */
export interface TimelineRevision {
  readonly revision: number
  readonly spec: Timeline['spec']
  readonly tracks: number
  readonly clips: number
  readonly durationMs: number
  readonly undo?: number
  readonly redo?: number
}

/** Explicit restoration is an edit; undo and redo follow the saved cursor links. */
export type TimelineRestoreMode = 'restore' | 'undo' | 'redo'
