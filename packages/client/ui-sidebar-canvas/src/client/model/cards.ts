/** What each node card shows besides the node itself: its state, versions, badges, and short summaries. */
import type { CanvasNode, NodeStatus, StoryboardSegment } from '@deepseek-ai/dsh-canvas/client'
import { summaryOf, rowsOf } from './table.ts'

/** One version the version bar offers. */
export interface VersionChoice {
  readonly id: string
  readonly label: string
  readonly active: boolean
}

export type ShotBadge =
  | { readonly scene: number; readonly segment: number }
  | { readonly scene: number; readonly segment?: never }
  | { readonly segment: number; readonly scene?: never }

/** State the card's status layer shows. */
export type CardState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'running'; readonly elapsedMs: number }
  | { readonly kind: 'failed'; readonly error: string; readonly retryable: boolean }

/** Version the node currently shows. */
export function currentVersion(node: CanvasNode): number {
  const versions = node.versions ?? []
  const index = versions.findIndex(version => version.id === node.activeVersion)
  return index < 0 ? Math.max(0, versions.length - 1) : index
}

/**
 * Versions the bar offers, newest last.
 * @param node - media node.
 * @returns one choice per version, or an empty list when the bar should stay hidden.
 */
export function versionChoices(node: CanvasNode): VersionChoice[] {
  const versions = node.versions ?? []
  if (versions.length < 2) return []
  const active = currentVersion(node)
  return versions.map((version, index) => ({ id: version.id, label: `v${String(index + 1)}`, active: index === active }))
}

/**
 * State of a node's generation job as the card draws it.
 * @param status - node status from the document.
 * @param now - current epoch milliseconds, for the elapsed time of a running job.
 * @returns the layer to draw.
 */
export function cardState(status: NodeStatus | undefined, now: number): CardState {
  if (status === undefined) return { kind: 'idle' }
  if (status.state === 'queued') return { kind: 'queued' }
  if (status.state === 'running') {
    const started = Date.parse(status.at)
    return { kind: 'running', elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0 }
  }
  return { kind: 'failed', error: status.error, retryable: status.retryable }
}

/**
 * Segment badge for a video made from a storyboard.
 * @param node - video node.
 * @param board - storyboard the segment belongs to, when the view has it.
 * @param scene - scene number the group records, when known.
 * @returns the scene and segment numbers, or undefined when the node is not a storyboard segment.
 */
export function shotBadge(
  node: CanvasNode,
  board?: CanvasNode,
  scene?: number,
  boardSegments: readonly StoryboardSegment[] = [],
): ShotBadge | undefined {
  const shots = node.gen?.shot?.shots
  if (shots === undefined || shots.length === 0) return undefined
  const key = [...shots].sort().join(',')
  const index = board === undefined ? -1 : boardSegments.findIndex(segment => [...segment.shots].sort().join(',') === key)
  const segment = index < 0 ? undefined : index + 1
  if (scene === undefined) return segment === undefined ? undefined : { segment }
  return segment === undefined ? { scene } : { scene, segment }
}

/**
 * Scenes a script body states: headings such as `【场1】雨夜`.
 * @param text - script text.
 * @returns scene numbers with their titles.
 */
export function scriptScenes(text: string): { readonly number: number; readonly title: string }[] {
  const scenes: { number: number; title: string }[] = []
  for (const line of text.split('\n')) {
    const match = /^[【\s]*场\s*([0-9０-９]+)[】\s]*(.*)$/u.exec(line.trim())
    if (match === null) continue
    /* v8 ignore next 2 -- the regexp guarantees both capture groups */
    const digits = (match[1] ?? '').replace(/[０-９]/gu, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    /* v8 ignore next -- the regexp guarantees the title capture */
    scenes.push({ number: Number(digits), title: (match[2] ?? '').trim() })
  }
  return scenes
}

/**
 * First lines of a script body, for the card preview.
 * @param text - script text.
 * @param lines - how many lines to keep.
 * @returns the preview, without empty lines.
 */
export function scriptPreview(text: string, lines = 3): string {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '').slice(0, lines).join('\n')
}

/**
 * Duration in seconds, as the cards pass it to their copy.
 * @param ms - milliseconds, when known.
 * @returns `12.3`, or undefined.
 */
export function durationSeconds(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : (ms / 1000).toFixed(1)
}

/** What a storyboard card's small table and footer show. */
export interface StoryboardRow {
  readonly id: string
  readonly title: string
  readonly shotSize: string
  readonly seconds: number
  readonly visual: string
}

/** What a storyboard card's small table and footer show. */
export interface StoryboardCardView {
  readonly rows: readonly StoryboardRow[]
  readonly summary: ReturnType<typeof summaryOf>
}

/**
 * Small table and footer text of one storyboard.
 * @param node - storyboard node.
 * @param maxSegmentSec - longest segment one generation call may cover.
 * @returns rows capped for the card plus the summary line.
 */
export function storyboardCardView(
  node: CanvasNode,
  segments: readonly StoryboardSegment[] = [],
): StoryboardCardView {
  const rows = rowsOf(node).map(shot => ({
    id: shot.id, title: shot.title, shotSize: shot.shotSize, seconds: shot.durationSec, visual: shot.visual,
  }))
  const summary = summaryOf(node, segments)
  return { rows, summary }
}

/**
 * Scene number a scene group records.
 * @param node - group node.
 * @returns the recorded scene number, when the group came from a script.
 */
export function groupScene(node: CanvasNode): number | undefined {
  return node.sceneOrigin?.scene
}
