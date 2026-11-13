/** The storyboard table's rows, cell edits, and the segmentation summary under it. */
import type { CanvasNode, CanvasOperation, Shot, ShotId, StoryboardSegment } from '@deepseek-ai/dsh-canvas/client'

/** Shots a storyboard currently shows. */
export function rowsOf(node: CanvasNode | undefined): readonly Shot[] {
  const versions = node?.versions ?? []
  return versions.find(version => version.id === node?.activeVersion)?.shots ?? versions.at(-1)?.shots ?? []
}

/** What the table footer states about one storyboard. */
export interface StoryboardSummary {
  readonly shots: number
  readonly seconds: number
  readonly segments: readonly StoryboardSegment[]
  readonly videoCalls: number
}

/**
 * Summary of one storyboard: shot count, total seconds, and how many video calls its segments need.
 * @param node - storyboard node.
 * @param maxSegmentSec - longest segment one generation call may cover.
 * @returns the counts the table footer shows.
 */
export function summaryOf(node: CanvasNode | undefined, segments: readonly StoryboardSegment[] = []): StoryboardSummary {
  const shots = rowsOf(node)
  /* v8 ignore next -- the Host validates every shot duration */
  const seconds = shots.reduce((sum, shot) => sum + Math.max(0.3, shot.durationSec), 0)
  return {
    shots: shots.length,
    seconds: Math.round(seconds * 10) / 10,
    segments,
    videoCalls: segments.length,
  }
}

/** Fields the table edits directly. */
export type TableField = 'shotSize' | 'visual' | 'motion' | 'camera' | 'durationSec' | 'characters' | 'scene' | 'sfx' | 'negative'

/** Value one cell edit carries. */
export type TableValue = string | readonly string[] | number

/**
 * Operation one cell edit sends.
 * @param node - storyboard node.
 * @param shot - shot being edited.
 * @param field - column being edited.
 * @param value - new value; a duration below one second is raised to one.
 * @returns the edit operation.
 */
export function cellOperation(
  node: CanvasNode, shot: ShotId, field: TableField, value: TableValue,
): CanvasOperation {
  if (field === 'durationSec') {
    const seconds = Math.max(1, Math.round(Number(value) * 10) / 10)
    return { op: 'update_shot', node: node.id, shot, patch: { durationSec: seconds } }
  }
  if (field === 'characters') {
    return { op: 'update_shot', node: node.id, shot, patch: { characters: [...value as readonly string[]] as never } }
  }
  if (field === 'scene' || field === 'shotSize') {
    return { op: 'update_shot', node: node.id, shot, patch: { [field]: value as never } }
  }
  return { op: 'update_shot', node: node.id, shot, patch: { [field]: String(value) } as never }
}

/**
 * Operation that appends a shot after the last one.
 * @param node - storyboard node.
 * @param template - fields the new shot starts from.
 * @returns the insert operation.
 */
export function appendShotOperation(node: CanvasNode, template: Omit<Shot, 'id'>): CanvasOperation {
  const rows = rowsOf(node)
  const last = rows.at(-1)
  return { op: 'insert_shot', node: node.id, ...last === undefined ? {} : { after: last.id }, shot: template }
}

/**
 * Operation that removes one shot.
 * @param node - storyboard node.
 * @param shot - shot to remove.
 * @returns the remove operation.
 */
export function removeShotOperation(node: CanvasNode, shot: ShotId): CanvasOperation {
  return { op: 'remove_shot', node: node.id, shot }
}

/**
 * Operations that move a shot after another one or to the front.
 * @param node - storyboard node.
 * @param shot - shot being moved.
 * @param after - shot it should follow, or undefined to move it first.
 * @returns the operation sequence needed for the requested position.
 */
export function moveShotOperations(node: CanvasNode, shot: ShotId, after: ShotId | undefined): CanvasOperation[] {
  const rows = rowsOf(node)
  if (!rows.some(row => row.id === shot) || after === shot) return []
  if (after !== undefined) return [{ op: 'move_shot', node: node.id, shot, after }]
  const first = rows[0]
  if (first === undefined || first.id === shot) return []
  return [
    { op: 'move_shot', node: node.id, shot, after: first.id },
    { op: 'move_shot', node: node.id, shot: first.id, after: shot },
  ]
}

/**
 * Segment one shot belongs to.
 * @param segments - segments of the storyboard.
 * @param shot - shot id.
 * @returns index of the segment that covers the shot, or -1.
 */
export function segmentOfShot(segments: readonly StoryboardSegment[], shot: ShotId): number {
  return segments.findIndex(segment => segment.shots.includes(shot))
}

/** Template a new table row starts from. */
export function blankShot(): Omit<Shot, 'id'> {
  return {
    title: '', shotSize: 'medium', visual: '', motion: '', camera: '', durationSec: 3,
    characters: [], props: [], dialogue: [], sfx: '', negative: '',
  }
}

/**
 * Segment color class one shot belongs to.
 * @param segments - segments of the storyboard.
 * @param shot - shot id.
 * @returns a stable class suffix in 0–3, or 0 when the shot is in no segment.
 */
export function segmentTone(segments: readonly StoryboardSegment[], shot: ShotId): number {
  const index = segmentOfShot(segments, shot)
  return index < 0 ? 0 : index % 4
}
