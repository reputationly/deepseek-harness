/**
 * Client-namespace projection of the canvas types.
 * @module @deepseek-ai/dsh-canvas/client
 */

export type * from './types.ts'
export type * from './timeline-types.ts'
export { activeVersionOf, previewVersionOf } from './versions.ts'
export { applyTimeline, parseTimeline, timelineDuration } from './timeline.ts'
export { edgeId, inferRole } from './roles.ts'
export { planShotSegments, shotSegmentKind } from './segments.ts'
