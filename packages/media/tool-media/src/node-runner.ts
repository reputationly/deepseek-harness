/**
 * Planning one generation run: which nodes generate what, which of their inputs are used, and
 * whether a gate stops the run before any money is spent.
 * @module
 */

import {
  activeVersionOf, gateBibleFirst, gateStoryboardQuality, planShotSegments,
  type Bible, type CanvasDocument, type CanvasEdge, type CanvasEdgeRole, type CanvasNode, type CanvasNodeId,
  type CanvasOperation, type Shot, type StoryboardSegment, type VersionId,
} from '@deepseek-ai/dsh-canvas'
import type { GenerationPlan, PlannedNode } from './budget.ts'

/** Bounds and model defaults one plan runs with. */
export interface PlanLimits {
  /** Longest video segment one call may cover, in seconds. */
  readonly maxVideoSeconds: number
  /** Video length used when a node states none, in seconds. */
  readonly videoDefaultDuration: number
  /** Video model for a segment that has a first frame. */
  readonly videoModel: string
  /** Video model for a segment with reference images only. */
  readonly videoRefModel: string
  readonly imageModel: string
  readonly speechModel: string
  readonly musicModel: string
}

/** One file an input edge supplies, resolved to the version it points at. */
export interface ResolvedInput {
  readonly node: CanvasNodeId
  readonly version: VersionId
  readonly path: string
  readonly role: CanvasEdgeRole
}

/** Everything one generation call consumes from the canvas. */
export interface NodeInputs {
  /** Prompt after prompt edges and `@name` mentions were expanded. */
  readonly prompt: string
  /** Reference images in edge order. */
  readonly refs: readonly ResolvedInput[]
  readonly firstFrame?: ResolvedInput
  readonly lastFrame?: ResolvedInput
}

/** One node the runner will generate, with what the plan knows about it. */
export interface PlannedGeneration extends PlannedNode {
  /** Storyboard this entry belongs to. */
  readonly storyboard?: CanvasNodeId
  /** Tail-frame image that becomes this segment's first frame. */
  readonly tailChain?: { readonly node: CanvasNodeId; readonly version: VersionId }
  /** Whether this segment must continue the picture of the segment before it. */
  readonly chain?: boolean
}

/** One plan plus the generation entries the runner executes. */
export interface NodePlan extends GenerationPlan {
  readonly entries: readonly PlannedGeneration[]
}

/** Character name a dialogue line names, for the prompt template. */
function speakerName(bible: Bible | undefined, line: Shot['dialogue'][number]): string {
  const speaker = line.speaker
  if (speaker.kind === 'narrator') return '旁白'
  return bible?.entries.find(entry => entry.id === speaker.entry)?.name ?? speaker.entry
}

/** One shot as the prompt template's line, with its timecodes. */
function shotPromptLine(shot: Shot, offsetSec: number, bible: Bible | undefined): string {
  const start = Math.round(offsetSec * 10) / 10
  const end = Math.round((offsetSec + shot.durationSec) * 10) / 10
  const dialogue = shot.dialogue.map(line => `${speakerName(bible, line)}：${line.line}`).join('；')
  const parts = [
    `${String(start)}–${String(end)}s [${shot.shotSize}] ${shot.visual}。动作：${shot.motion}。运镜：${shot.camera}`,
    ...dialogue === '' ? [] : [`台词（${dialogue}）`],
    `避免：${shot.negative}`,
  ]
  return parts.join('。')
}

/**
 * Prompt a video node sends for the shots it covers.
 * @param shots - shots the segment covers, in order.
 * @param bible - bible used to name the speakers.
 * @returns one template line per shot.
 */
export function segmentPrompt(shots: readonly Shot[], bible: Bible | undefined): string {
  let offset = 0
  const lines: string[] = []
  for (const shot of shots) {
    lines.push(shotPromptLine(shot, offset, bible))
    offset += shot.durationSec
  }
  return lines.join('\n')
}

/** Edges into one node, in a stable order. */
function incoming(document: CanvasDocument, node: CanvasNodeId): readonly CanvasEdge[] {
  return document.edges
    .filter(edge => edge.target === node)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
}

/** File and version one edge's source currently shows. */
function resolveInput(document: CanvasDocument, edge: CanvasEdge): ResolvedInput | undefined {
  const source = document.nodes.find(node => node.id === edge.source)
  if (source === undefined) return undefined
  const version = activeVersionOf(source)
  if (version?.path === undefined) return undefined
  return { node: source.id, version: version.id, path: version.path, role: edge.role ?? 'source' }
}

/** Expand `@name` mentions into the bible entry's description. */
function expandMentions(prompt: string, bible: Bible | undefined): string {
  if (bible === undefined) return prompt
  return prompt.replace(/@([\p{L}\p{N}_-]+)/gu, (match, name: string) => {
    const entry = bible.entries.find(candidate => candidate.name === name || candidate.aliases.includes(name))
    return entry === undefined ? match : `${entry.name}（${entry.description}）`
  })
}

/** First image node a bible entry points at, resolved to its current file. */
function entryReference(document: CanvasDocument, entry: { readonly imageNodes: readonly string[] }): ResolvedInput | undefined {
  const node = document.nodes.find(candidate => candidate.id === entry.imageNodes[0])
  const version = node === undefined ? undefined : activeVersionOf(node)
  if (node === undefined || version?.path === undefined) return undefined
  return { node: node.id, version: version.id, path: version.path, role: 'ref' }
}

/**
 * Collect the prompt and files one node generates from.
 * @param document - the episode's canvas.
 * @param node - node being generated.
 * @param bible - bible that names speakers and locates storyboard prompts.
 * @returns the prompt, reference images in edge order, and the frame slots.
 */
export function collectInputs(document: CanvasDocument, node: CanvasNode, bible: Bible | undefined): NodeInputs {
  const edges = incoming(document, node.id)
  const sources = edges.map(edge => ({ edge, source: document.nodes.find(candidate => candidate.id === edge.source) }))
  const textPrompts = sources
    .filter(entry => entry.source?.type === 'text' || entry.source?.type === 'script')
    .filter(entry => entry.edge.role === 'prompt')
    .map(entry => activeVersionOf(entry.source as CanvasNode)?.text ?? '')
  const storyboardPrompts = sources
    .filter(entry => entry.edge.role === 'prompt' && entry.source?.type === 'storyboard')
    .map((entry) => {
      const shots = activeVersionOf(entry.source as CanvasNode)?.shots ?? []
      const covered = node.gen?.shot?.shots
      return segmentPrompt(covered === undefined ? shots : shots.filter(shot => covered.includes(shot.id)), bible)
    })
  const joined = [...textPrompts, ...storyboardPrompts, node.gen?.prompt ?? ''].filter(part => part !== '').join('\n\n')
  const prompt = expandMentions(joined, bible)
  const resolved = edges.map(edge => ({ edge, input: resolveInput(document, edge) }))
  const edgeRefs = resolved.filter(entry => entry.edge.role === 'ref' && entry.input !== undefined).map(entry => entry.input as ResolvedInput)
  const mentioned = bible === undefined
    ? []
    : bible.entries
      .filter(entry => joined.includes(`@${entry.name}`) || entry.aliases.some(alias => joined.includes(`@${alias}`)))
      .map(entry => entryReference(document, entry))
      .filter((input): input is ResolvedInput => input !== undefined)
  const refs = [...edgeRefs]
  for (const input of mentioned) {
    if (!refs.some(ref => ref.node === input.node)) refs.push(input)
  }
  const firstFrame = resolved.find(entry => entry.edge.role === 'first_frame')?.input
  const lastFrame = resolved.find(entry => entry.edge.role === 'last_frame')?.input
  return {
    prompt,
    refs,
    ...firstFrame === undefined ? {} : { firstFrame },
    ...lastFrame === undefined ? {} : { lastFrame },
  }
}

/** Shots one segment covers, in storyboard order. */
function shotsOfSegment(shots: readonly Shot[], segment: StoryboardSegment): readonly Shot[] {
  const ids = new Set(segment.shots)
  return shots.filter(shot => ids.has(shot.id))
}

/** Existing video node that already stands for one segment. */
function videoForSegment(document: CanvasDocument, storyboard: CanvasNodeId, segment: StoryboardSegment): CanvasNode | undefined {
  const wanted = [...segment.shots].sort().join(',')
  return document.nodes.find(node => node.type === 'video'
    && node.gen?.shot?.storyboard === storyboard
    && [...node.gen.shot.shots].sort().join(',') === wanted
    && node.stale !== true)
}

/** Model default for one node's kind. */
function defaultModel(node: CanvasNode, limits: PlanLimits): string {
  if (node.type === 'image') return limits.imageModel
  if (node.type === 'video') return limits.videoModel
  return node.gen?.kind === 'music' ? limits.musicModel : limits.speechModel
}

/** A plan that one gate refuses outright. */
function refused(gate: NonNullable<GenerationPlan['blocked']>): NodePlan {
  return { nodes: [], create: [], stale: [], segments: [], entries: [], blocked: gate }
}

/**
 * Plan a generation run for the nodes a caller names.
 * @param document - the episode's canvas.
 * @param bible - the project's bible, when it has one.
 * @param requested - node ids to generate; a storyboard plans one node per segment.
 * @param limits - segment bounds and model defaults.
 * @returns the plan, the canvas edits it needs, and the gate that blocks it when one does.
 */
export function planNodes(
  document: CanvasDocument,
  bible: Bible | undefined,
  requested: readonly string[],
  limits: PlanLimits,
): NodePlan {
  const create: CanvasOperation[] = []
  const entries: PlannedGeneration[] = []
  const segments: { storyboard: CanvasNodeId; index: number; shots: readonly string[] }[] = []
  const stale: CanvasNodeId[] = []

  for (const id of requested) {
    const node = document.nodes.find(candidate => candidate.id === id)
    if (node === undefined) throw new Error(`canvas node ${id} does not exist`)
    if (node.type === 'storyboard') {
      const quality = gateStoryboardQuality(document, bible)
      if (quality !== undefined) return refused(quality)
      const shots = activeVersionOf(node)?.shots ?? []
      const plan = planShotSegments(shots, { maxSegmentSec: limits.maxVideoSeconds })
      let previous: {
        readonly node: CanvasNodeId
        readonly generated: boolean
        readonly tail?: { readonly node: CanvasNodeId; readonly version: VersionId }
      } | undefined
      for (const [index, segment] of plan.segments.entries()) {
        const existing = videoForSegment(document, node.id, segment)
        const covered = shotsOfSegment(shots, segment)
        const model = previous?.tail === undefined ? limits.videoRefModel : limits.videoModel
        const createdRef = `segment-${String(index)}`
        const chosen: PlannedGeneration = {
          node: (existing?.id ?? createdRef) as CanvasNodeId,
          ...existing === undefined ? { ref: createdRef } : {},
          kind: 'video',
          model: existing?.gen?.model ?? model,
          calls: 1,
          lines: 1,
          seconds: Math.min(segment.durationSec, limits.maxVideoSeconds),
          shots: covered.map(shot => shot.title),
          storyboard: node.id,
          ...segment.needsTailChain ? { chain: true } : {},
          ...segment.needsTailChain && previous?.tail !== undefined ? { tailChain: previous.tail } : {},
        }
        if (existing === undefined) {
          create.push({
            op: 'add',
            ref: createdRef,
            type: 'video',
            title: `${node.title} · 段${String(index + 1)}`,
            gen: {
              kind: 'video',
              prompt: segmentPrompt(covered, bible),
              model,
              params: { duration: Number(chosen.seconds) },
              shot: { storyboard: node.id, shots: segment.shots },
            },
          })
        }
        entries.push(chosen)
        segments.push({ storyboard: node.id, index, shots: segment.shots })
        previous = {
          node: chosen.node,
          generated: existing === undefined,
          ...existing?.tailOf === undefined ? {} : { tail: existing.tailOf },
        }
      }
      for (const candidate of document.nodes) {
        if (candidate.type !== 'video' || candidate.gen?.shot?.storyboard !== node.id || candidate.stale === true) continue
        const wanted = [...candidate.gen.shot.shots].sort().join(',')
        if (!plan.segments.some(segment => [...segment.shots].sort().join(',') === wanted)) stale.push(candidate.id)
      }
      continue
    }
    if (node.gen === undefined || (node.type !== 'image' && node.type !== 'video' && node.type !== 'audio')) {
      throw new Error(`canvas node ${node.id} does not generate media`)
    }
    if (node.gen.prompt.includes('@')) {
      const bibleGate = gateBibleFirst(bible)
      if (bibleGate !== undefined) return refused(bibleGate)
    }
    if (node.type === 'video' && node.gen.shot !== undefined) {
      const board = document.nodes.find(candidate => candidate.id === node.gen?.shot?.storyboard)
      const ordered = board === undefined
        ? []
        : planShotSegments(activeVersionOf(board)?.shots ?? [], { maxSegmentSec: limits.maxVideoSeconds }).segments
      const wanted = [...node.gen.shot.shots].sort().join(',')
      const position = ordered.findIndex(segment => [...segment.shots].sort().join(',') === wanted)
      if (position > 0) {
        const before = videoForSegment(document, node.gen.shot.storyboard, ordered[position - 1] as StoryboardSegment)
        if (before?.tailOf === undefined) {
          return refused({
            gate: 'tail_chain',
            missing: [`${node.id} needs the tail frame of segment ${String(position - 1)}, which has not been generated`],
          })
        }
      }
    }
    const model = node.gen.model ?? defaultModel(node, limits)
    entries.push({
      node: node.id,
      kind: node.gen.kind,
      model,
      calls: 1,
      lines: 1,
      ...node.gen.kind === 'video' ? { seconds: Number(node.gen.params.duration ?? limits.videoDefaultDuration) } : {},
      ...node.gen.kind === 'speech' ? { lines: 1 } : {},
    })
  }

  return { nodes: entries, create, stale, segments, entries }
}
