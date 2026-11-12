/** What each node card shows besides the node itself: its state, versions, badges, and short summaries. */
import type { CanvasNode, NodeStatus } from '@deepseek-ai/dsh-canvas/client'
import { summaryOf, rowsOf } from './table.ts'

/** One version the version bar offers. */
export interface VersionChoice {
  readonly id: string
  readonly label: string
  readonly active: boolean
}

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
 * @returns e.g. `场2·段1`, or undefined when the node is not a storyboard segment.
 */
export function shotBadge(node: CanvasNode, board?: CanvasNode, scene?: number): string | undefined {
  const shots = node.gen?.shot?.shots
  if (shots === undefined || shots.length === 0) return undefined
  const key = [...shots].sort().join(',')
  const segments = board === undefined ? [] : summaryOf(board).segments
  const index = segments.findIndex(segment => [...segment.shots].sort().join(',') === key)
  const segment = index < 0 ? undefined : `段${String(index + 1)}`
  const prefix = scene === undefined ? undefined : `场${String(scene)}`
  if (prefix === undefined && segment === undefined) return undefined
  return [prefix, segment].filter(part => part !== undefined).join('·')
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
    const digits = (match[1] ?? '').replace(/[０-９]/gu, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
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
 * Duration as the cards show it.
 * @param ms - milliseconds, when known.
 * @returns `12.3s`, or undefined.
 */
export function durationLabel(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : `${(ms / 1000).toFixed(1)}s`
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
  readonly summary: string
}

/**
 * Small table and footer text of one storyboard.
 * @param node - storyboard node.
 * @param maxSegmentSec - longest segment one generation call may cover.
 * @returns rows capped for the card plus the summary line.
 */
export function storyboardCardView(node: CanvasNode, maxSegmentSec = 15): StoryboardCardView {
  const rows = rowsOf(node).map(shot => ({
    id: shot.id, title: shot.title, shotSize: shot.shotSize, seconds: shot.durationSec, visual: shot.visual,
  }))
  const summary = summaryOf(node, maxSegmentSec)
  const text = [
    `${String(summary.shots)} 镜`, `${String(summary.seconds)} 秒`,
    `${String(summary.segments.length)} 段`, `${String(summary.videoCalls)} 次生成`,
  ].join(' · ')
  return { rows, summary: text }
}

/**
 * Scene number a scene group records.
 * @param node - group node.
 * @returns the recorded scene number, when the group came from a script.
 */
export function groupScene(node: CanvasNode): number | undefined {
  return node.sceneOrigin?.scene
}
