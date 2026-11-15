/** Pure editor conversions; all mutations still use the shared timeline command language. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasDocument, Timeline, TimelineClip, TimelineClipId, TimelineTrackId, TimelineTrack } from '@deepseek-ai/dsh-canvas/client'

/** Numeric branded ids keep the file protocol while avoiding reuse after deleting a clip. */
function fresh(prefix: 'k' | 't'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return `${prefix}${String(new DataView(bytes.buffer).getBigUint64(0) + 1n)}`
}
/**
 * Allocate a clip identity independently of saved document revisions.
 * @returns A new clip identity.
 */
export function clipId(): TimelineClipId { return brandString<TimelineClipId>(fresh('k')) }
/**
 * Allocate a track identity independently of saved document revisions.
 * @returns A new track identity.
 */
export function trackId(): TimelineTrackId { return brandString<TimelineTrackId>(fresh('t')) }
/**
 * Name a pinned media clip or caption for editor controls.
 * @param clip - Clip whose timing, source, or label is being evaluated.
 * @param canvas - Canvas containing the pinned media sources.
 * @returns The caption text or pinned source title.
 */
export function clipName(clip: TimelineClip, canvas: CanvasDocument): string {
  return clip.text?.content || canvas.nodes.find(node => node.id === clip.source?.node)?.title || clip.id
}
/**
 * Format integer milliseconds as an editable seconds value.
 * @param ms - Time in milliseconds.
 * @returns Seconds formatted for the editor input.
 */
export function seconds(ms: number): string { return String(Number((ms / 1000).toFixed(3))) }
/**
 * Parse a seconds form value into integer milliseconds.
 * @param value - Seconds text from the editor input.
 * @returns The parsed millisecond value.
 */
export function milliseconds(value: string): number { return Math.round(Number(value) * 1000) }
/**
 * Check whether a clip can move to a track without changing its source kind.
 * @param track - Destination track whose accepted source kinds are checked.
 * @param clip - Clip whose timing, source, or label is being evaluated.
 * @param canvas - Canvas containing the pinned media sources.
 * @returns Whether the target track accepts the existing source.
 */
export function trackAccepts(track: TimelineTrack, clip: TimelineClip, canvas: CanvasDocument): boolean {
  if (clip.text !== undefined) return track.kind === 'text'
  const type = canvas.nodes.find(node => node.id === clip.source?.node)?.type
  return track.kind === 'audio' ? type === 'audio' || type === 'video' : track.kind === 'video' && (type === 'image' || type === 'video')
}
/**
 * Output dimensions and frame rates offered by the timeline setup form.
 */
export const OUTPUT_SPECS = [
  { width: 1080, height: 1920, fps: 24 }, { width: 1920, height: 1080, fps: 24 },
  { width: 1440, height: 2560, fps: 24 }, { width: 2560, height: 1440, fps: 24 },
] as const satisfies readonly Timeline['spec'][]
