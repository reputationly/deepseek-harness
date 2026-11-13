/**
 * Production stages and the gates that guard them.
 * @module
 */

import { activeVersionOf, CanvasCorruptError } from './document.ts'
import type { Bible } from './bible.ts'
import type { CanvasDocument, CanvasNode, EpisodeProduction, GateId, Production, StageId } from './types.ts'

/** Stages in the order a production runs them. */
export const STAGE_ORDER: readonly StageId[] = [
  'brief', 'bible', 'assets', 'script', 'storyboard', 'generating', 'post', 'delivered',
]

/** The production of a project that has none yet. */
export const EMPTY_PRODUCTION: Production = { version: 1, revision: 0, episodes: {} }

/** One gate that refused an action. */
export interface GateRefusal {
  readonly gate: GateId
  /** What is missing, naming nodes, shots, or bible entries. */
  readonly missing: readonly string[]
}

/**
 * Parse a production file.
 * @param source - file content.
 * @returns the validated production.
 * @throws Error naming the field that is not a production file.
 */
export function parseProduction(source: string): Production {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error: unknown) {
    throw new Error(`production.json: ${String(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('production.json: document is not an object')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) throw new Error(`production.json: unsupported version ${JSON.stringify(raw.version)}`)
  if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0) {
    throw new Error('production.json: revision is not a non-negative integer')
  }
  if (typeof raw.episodes !== 'object' || raw.episodes === null || Array.isArray(raw.episodes)) {
    throw new Error('production.json: episodes is not an object')
  }
  const episodes: Record<string, EpisodeProduction> = {}
  for (const [episode, entry] of Object.entries(raw.episodes as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`production.json: episodes.${episode} is not an object`)
    const record = entry as Record<string, unknown>
    const stage = record.stage
    if (typeof stage !== 'string' || !(STAGE_ORDER as readonly string[]).includes(stage)) {
      throw new Error(`production.json: episodes.${episode}.stage is unknown`)
    }
    const overrides = Array.isArray(record.overrides) ? record.overrides : []
    episodes[episode] = {
      stage: stage as StageId,
      overrides: overrides.map((override, index) => {
        if (typeof override !== 'object' || override === null || Array.isArray(override)) {
          throw new Error(`production.json: episodes.${episode}.overrides[${String(index)}] is not an object`)
        }
        const held = override as Record<string, unknown>
        if (typeof held.gate !== 'string' || typeof held.at !== 'string' || typeof held.reason !== 'string') {
          throw new Error(`production.json: episodes.${episode}.overrides[${String(index)}] needs gate, at, and reason`)
        }
        return { gate: held.gate as GateId, at: held.at, reason: held.reason }
      }),
    }
  }
  return { version: 1, revision: raw.revision, episodes }
}

/**
 * Serialize a production file.
 * @param production - validated production.
 * @returns pretty-printed JSON ending in a newline.
 */
export function serializeProduction(production: Production): string {
  return `${JSON.stringify(production, null, 2)}\n`
}

/**
 * Stage one episode has reached.
 * @param production - the project's production record.
 * @param episode - episode id.
 * @returns the stage, or `brief` when the episode has no record yet.
 */
export function stageOf(production: Production, episode: string): StageId {
  return production.episodes[episode]?.stage ?? 'brief'
}

/**
 * Move one episode to a later stage.
 * @param production - the project's production record.
 * @param episode - episode id.
 * @param to - stage to record.
 * @param override - reason for skipping a stage, which also records the override.
 * @param at - ISO timestamp of the change.
 * @returns the next production record.
 * @throws Error when the stage would move backwards or skip stages without an override.
 */
export function advanceStage(
  production: Production,
  episode: string,
  to: StageId,
  override: { readonly gate: GateId; readonly reason: string } | undefined,
  at: string,
): Production {
  const current = stageOf(production, episode)
  const currentIndex = STAGE_ORDER.indexOf(current)
  const targetIndex = STAGE_ORDER.indexOf(to)
  if (targetIndex < currentIndex && override === undefined) {
    throw new Error(`canvas: stage cannot move back from ${current} to ${to} without an override`)
  }
  if (targetIndex > currentIndex + 1 && override === undefined) {
    throw new Error(`canvas: stage cannot skip from ${current} to ${to} without an override`)
  }
  const record = production.episodes[episode] ?? { stage: current, overrides: [] }
  return {
    ...production,
    episodes: {
      ...production.episodes,
      [episode]: {
        stage: to,
        overrides: override === undefined ? record.overrides : [...record.overrides, { gate: override.gate, at, reason: override.reason }],
      },
    },
  }
}

/** One shot that cannot be generated yet. */
interface ShotProblem {
  readonly node: CanvasNode
  readonly shot: string
  readonly missing: readonly string[]
}

/** Shots of one storyboard missing a field the video gate needs. */
function storyboardProblems(document: CanvasDocument, bible: Bible | undefined): readonly ShotProblem[] {
  const known = new Set((bible?.entries ?? []).map(entry => entry.id))
  const problems: ShotProblem[] = []
  for (const node of document.nodes) {
    if (node.type !== 'storyboard') continue
    for (const shot of activeVersionOf(node)?.shots ?? []) {
      const missing: string[] = []
      if (shot.shotSize === undefined) missing.push('shotSize')
      if (!(shot.durationSec >= 1)) missing.push('durationSec')
      const entries = [...shot.characters, ...shot.props, ...(shot.scene === undefined ? [] : [shot.scene])]
      for (const entry of entries) if (!known.has(entry)) missing.push(`bible entry ${entry}`)
      for (const line of shot.dialogue) {
        if (line.speaker.kind === 'character' && !known.has(line.speaker.entry)) missing.push(`bible entry ${line.speaker.entry}`)
      }
      if (missing.length > 0) problems.push({ node, shot: shot.id, missing })
    }
  }
  return problems
}

/**
 * Check that generated images can start: the bible must already name what they depict.
 * @param bible - the project's bible, when it has one.
 * @returns every missing entry a reference image needs, empty when the gate passes.
 */
export function gateBibleFirst(bible: Bible | undefined): GateRefusal | undefined {
  const entries = bible?.entries ?? []
  if (entries.length > 0) return undefined
  return { gate: 'G1_bible_first', missing: ['bible.json has no entries'] }
}

/**
 * Check that a storyboard is complete enough to generate video from.
 * @param document - the episode's canvas.
 * @param bible - the project's bible.
 * @returns the gate refusal with every missing field, or undefined when it passes.
 */
export function gateStoryboardQuality(document: CanvasDocument, bible: Bible | undefined): GateRefusal | undefined {
  const problems = storyboardProblems(document, bible)
  if (problems.length === 0) return undefined
  return {
    gate: 'G2_storyboard_quality',
    missing: problems.flatMap(problem => problem.missing.map(field => `${problem.node.id} shot ${problem.shot}: ${field}`)),
  }
}

/**
 * Group the video nodes of one storyboard by the shots they stand for.
 * @param document - the episode's canvas.
 * @param storyboard - storyboard node id.
 * @returns one entry per distinct shot group, listing the video nodes that claim it.
 */
export function videoNodesByShots(
  document: CanvasDocument,
  storyboard: string,
): readonly { readonly shots: readonly string[]; readonly nodes: readonly CanvasNode[] }[] {
  const groups = new Map<string, CanvasNode[]>()
  for (const node of document.nodes) {
    if (node.type !== 'video' || node.gen?.shot?.storyboard !== storyboard) continue
    const key = [...node.gen.shot.shots].join(',')
    groups.set(key, [...groups.get(key) ?? [], node])
  }
  return [...groups.entries()].map(([key, nodes]) => ({ shots: key === '' ? [] : key.split(','), nodes }))
}

/**
 * Load a production file, refusing a version this build cannot read.
 * @param source - file content.
 * @returns the validated production.
 * @throws {@link CanvasCorruptError} when the file is not a production file.
 */
export function parseProductionFile(source: string): Production {
  try {
    return parseProduction(source)
  } catch (error: unknown) {
    throw new CanvasCorruptError(String(error))
  }
}
