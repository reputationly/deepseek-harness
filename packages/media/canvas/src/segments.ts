/**
 * How one storyboard table splits into generation segments.
 *
 * Ported from `@ninkch/dsh-infinite-canvas` 0.20.5 `shot-segments.js` (Apache-2.0): the greedy
 * break search, the cut-point rules, the forced-seam warnings, and the tail-merge tolerance follow
 * that implementation; the fields are mapped onto this package's {@link Shot}. Budget quotes and
 * the generation runner both call this function, so a quote can never disagree with the work.
 * @module
 */

import type { Shot, StoryboardSegment } from './types.ts'

/** How one shot relates to the shot before it. */
export type SegmentKind = StoryboardSegment['kind']

/** How the seam between two segments is expected to join. */
export type SegmentJoin = StoryboardSegment['join']

/** Inputs a deployment tunes; the defaults are the ones the ported algorithm was recorded with. */
export interface SegmentOptions {
  /** Longest segment one generation call may cover, in seconds. */
  readonly maxSegmentSec?: number
  /** Shortest segment worth generating on its own, in seconds. */
  readonly minSegmentSec?: number
}

/** One planning result over a whole storyboard. */
export interface SegmentPlan {
  readonly segments: readonly StoryboardSegment[]
  /** Total duration of the usable shots, in tenths of a second. */
  readonly totalSec: number
  readonly maxSegmentSec: number
  /** `clean` when every segment starts on a cut point; `forced` when a long run had to be cut mid-shot. */
  readonly cutMode: 'clean' | 'forced' | 'empty'
  /** What a user should know about the split, such as a forced seam or a merged tail. */
  readonly warnings: readonly string[]
}

const SCENE_CHANGE = /换场|场景切换|转场|另一处|另一场景|切至|切到|次日|翌日|与此同时|数日后|[Cc]ut to/u
const NEW_CHARACTER = /新角色|首次出场|走进来|入镜|入场|冒出|推门进|[Ee]nters?/u
const CUT_SHOT_SIZES: readonly Shot['shotSize'][] = ['close', 'extreme_close', 'insert']

/** Cue text a shot carries for the inference below. */
function cueOf(shot: Shot): string {
  return [shot.visual, shot.motion].map(part => part.trim()).filter(part => part !== '').join('；')
}

/** Duration of one shot with the algorithm's floor and rounding. */
function durationOf(shot: Shot): number {
  return Math.max(0.3, Math.round((Number(shot.durationSec) || 3) * 10) / 10)
}

/**
 * Kind of one shot from its content and the shot before it.
 * @param shot - the shot being classified.
 * @param previous - the shot before it, or undefined for the first shot of the table.
 * @returns the segment kind.
 */
export function shotSegmentKind(shot: Shot, previous: Shot | undefined): SegmentKind {
  if (previous === undefined) return 'opening'
  const cue = cueOf(shot)
  if (SCENE_CHANGE.test(cue)) return 'scene_change'
  if (NEW_CHARACTER.test(cue)) return 'new_character'
  const dialogueLines = shot.dialogue.length
  if (CUT_SHOT_SIZES.includes(shot.shotSize) || durationOf(shot) < 1.5 && dialogueLines === 0) return 'closeup'
  return 'continuation'
}

/** Whether a kind starts a new camera setup, so a segment may begin there. */
function isCutPoint(kind: SegmentKind): boolean {
  return kind !== 'continuation'
}

/** Join a segment starting with one kind expects. */
function joinOf(kind: SegmentKind): SegmentJoin {
  if (kind === 'scene_change' || kind === 'new_character') return 'loose'
  if (kind === 'closeup') return 'cut'
  return 'strict'
}

/** A shot that can actually become a segment: it describes a picture, an action, or a line. */
function usable(shot: Shot): boolean {
  return shot.visual.trim() !== '' || shot.motion.trim() !== '' || shot.dialogue.length > 0
}

/**
 * Split a storyboard into generation segments.
 * @param shots - shots of one storyboard version, in order.
 * @param options - segment bounds a deployment allows.
 * @returns the segments, their total duration, and what a user should know about the split.
 */
export function planShotSegments(shots: readonly Shot[], options: SegmentOptions = {}): SegmentPlan {
  const maxSegmentSec = Math.max(1, Number(options.maxSegmentSec) || 15)
  const minSegmentSec = Math.max(0, Math.min(Number(options.minSegmentSec) || 2, maxSegmentSec))
  const list = shots.filter(usable)
  const warnings: string[] = []
  if (list.length === 0) {
    return { segments: [], totalSec: 0, maxSegmentSec, cutMode: 'empty', warnings: ['the storyboard has no usable shots'] }
  }
  const kinds = list.map((shot, index) => shotSegmentKind(shot, list[index - 1]))
  const totalSec = Math.round(list.reduce((sum, shot) => sum + durationOf(shot), 0) * 10) / 10

  /** End index (inclusive) of the longest segment starting at `from` that ends on a cut point. */
  const findBreak = (from: number): { readonly end: number; readonly forced: boolean } => {
    let accumulated = 0
    let bestCut = -1
    for (let index = from; index < list.length; index += 1) {
      const duration = durationOf(list[index] as Shot)
      if (accumulated + duration > maxSegmentSec + 1e-6) break
      accumulated += duration
      const nextKind = kinds[index + 1]
      if (nextKind !== undefined && isCutPoint(nextKind)) bestCut = index
      else if (isCutPoint(kinds[index] as SegmentKind)) bestCut = index > from ? index - 1 : index
      if (index === list.length - 1) bestCut = index
    }
    if (bestCut < from) return { end: from, forced: true }
    return { end: bestCut, forced: false }
  }

  const segments: StoryboardSegment[] = []
  let start = 0
  while (start < list.length && segments.length < 128) {
    const { end, forced } = findBreak(start)
    const kind = kinds[start] as SegmentKind
    const opensOnCut = segments.length === 0 || isCutPoint(kind)
    const shotIds = list.slice(start, end + 1).map(shot => shot.id)
    const durationSec = Math.round(
      list.slice(start, end + 1).reduce((sum, shot) => sum + durationOf(shot), 0) * 10,
    ) / 10
    const seal = segments.length
    if (!opensOnCut) {
      warnings.push(`segment ${String(seal + 1)} starts mid-shot because the previous segment had no cut point`)
    }
    segments.push({
      index: segments.length,
      shots: shotIds,
      durationSec,
      kind,
      join: joinOf(kind),
      needsTailChain: seal > 0 && !opensOnCut,
    })
    if (end === start && forced) {
      warnings.push(`shot ${String(start + 1)} alone lasts ${String(durationOf(list[start] as Shot))}s, over the ${String(maxSegmentSec)}s limit`)
    }
    start = end + 1
  }

  // A one-second tail segment is worse to generate than a segment slightly over the limit.
  if (segments.length > 1) {
    const last = segments[segments.length - 1] as StoryboardSegment
    const previous = segments[segments.length - 2] as StoryboardSegment
    const tolerance = Math.max(0.6, maxSegmentSec * 0.1)
    const tinyTail = last.durationSec <= Math.max(minSegmentSec, maxSegmentSec * 0.2)
    if (tinyTail && previous.durationSec + last.durationSec <= maxSegmentSec + tolerance) {
      segments[segments.length - 2] = {
        ...previous,
        shots: [...previous.shots, ...last.shots],
        durationSec: Math.round((previous.durationSec + last.durationSec) * 10) / 10,
      }
      segments.pop()
      warnings.push(`the ${String(last.durationSec)}s tail segment was merged into the one before it`)
    }
  }

  const cleanCuts = segments.every(segment => segment.index === 0 || isCutPoint(segment.kind))
  const cutMode = cleanCuts ? 'clean' : 'forced'
  if (cutMode === 'forced') {
    warnings.push('some segments start mid-shot; splitting the long take into two shots would give every segment a real cut point')
  }
  return { segments, totalSec, maxSegmentSec, cutMode, warnings }
}
