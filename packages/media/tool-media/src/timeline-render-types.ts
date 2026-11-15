/** Serializable plans and progress shared by the Host writer and its browser renderer. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Timeline, CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { TimelineRenderStyle } from '@deepseek-ai/dsh-util-timeline-compositor'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Renderer notifications carry their owning Session for resource-scoped forwarding. */
export interface TimelineRenderNotice {
  readonly sessionId: SessionId
  readonly directory: string
  readonly node: CanvasNodeId
  readonly episode: EpisodeId
  readonly jobId: JobId
  readonly state: TimelineRenderState
  readonly revision: number
}

/**
 * Content identity of one reusable full-quality cache segment.
 */
export type TimelineCacheKey = Branded<'TimelineCacheKey'>
/**
 * Opaque ownership token fencing uploads from a superseded renderer.
 */
export type TimelineRenderLease = Branded<'TimelineRenderLease'>

/** A source version and its filesystem identity, captured before rendering. */
export interface TimelineRenderAsset {
  readonly node: CanvasNodeId
  readonly version: VersionId
  readonly kind: 'image' | 'video' | 'audio'
  readonly path: string
  readonly size: number
  readonly modifiedMs: number
}

/** One frame-aligned block of composed video and lossless stereo PCM. */
export interface TimelineRenderSegment {
  readonly key: TimelineCacheKey
  readonly fromFrame: number
  readonly toFrame: number
  readonly videoPath?: string
  readonly audioPath?: string
}

/** Immutable input for both full-quality preview and export. */
export interface TimelineRenderPlan {
  readonly version: 1
  readonly key: TimelineCacheKey
  readonly node: CanvasNodeId
  readonly episode: EpisodeId
  readonly document: Timeline
  readonly assets: readonly TimelineRenderAsset[]
  readonly style: TimelineRenderStyle
  readonly font?: { readonly path: string; readonly size: number; readonly modifiedMs: number }
  readonly frames: number
  readonly sampleRate: 48000
  readonly channels: 2
  readonly videoBitrate: number
  readonly audioBitrate: number
  readonly maxChunkBytes: number
  readonly maxActiveSources: number
  readonly sourceCacheBytes: number
  readonly maxImageBytes: number
  readonly maxSourcePixels: number
  readonly audioWindowSamples: number
  readonly heartbeatMs: number
  readonly segments: readonly TimelineRenderSegment[]
}

/**
 * Persisted lifecycle state of a full-quality render task.
 */
export type TimelineRenderState = 'stale' | 'queued' | 'rendering' | 'assembling' | 'ready' | 'cancelled' | 'interrupted' | 'failed'
/**
 * Failure category exposed by a render task for actionable recovery.
 */
export type TimelineRenderErrorCode = 'source' | 'encoding' | 'upload' | 'lease' | 'probe' | 'storage' | 'renderer'

/** The preview path is only exposed when it matches the current timeline revision and source identities. */
export interface TimelineRenderView {
  readonly revision: number
  readonly state: TimelineRenderState
  readonly progress: number
  readonly jobId?: JobId
  readonly path?: string
  readonly error?: { readonly code: TimelineRenderErrorCode; readonly message: string }
}

/** Exactly one connected renderer may upload under a live lease. */
export interface TimelineRenderWork {
  readonly lease: TimelineRenderLease
  readonly jobId: JobId
  readonly plan: Omit<TimelineRenderPlan, 'segments'> & { readonly segments: readonly TimelineRenderBlock[] }
}

/** Host-chosen paths are available for both new and reusable blocks. */
export interface TimelineRenderBlock extends TimelineRenderSegment {
  readonly videoPath: string
  readonly audioPath: string
  readonly cached: boolean
}

/** An upload target; filesystem paths always come from the Host plan. */
export type TimelineRenderPart =
  | { readonly kind: 'video' | 'audio'; readonly segment: TimelineCacheKey }
  | { readonly kind: 'output' }

/** An immutable MP4 placed outside disposable caches and linked back to its editing timeline. */
export interface TimelineExportResult {
  readonly node: CanvasNodeId
  readonly path: string
  readonly revision: number
}
