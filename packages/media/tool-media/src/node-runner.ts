/**
 * Planning one generation run: which nodes generate what, which of their inputs are used, and
 * whether a gate stops the run before any money is spent.
 * @module
 */

import {
  activeVersionOf,
  gateBibleFirst,
  gateStoryboardQuality,
  planShotSegments,
  type Bible,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasEdgeRole,
  type CanvasNode,
  type CanvasNodeId,
  type CanvasOperation,
  type Shot,
  type StoryboardSegment,
  type VersionId,
} from '@deepseek-ai/dsh-canvas'
import type { GenerationPlan, PlannedNode } from './budget.ts'
import { imagePixelSize } from './planner.ts'

/** Bounds and model defaults one plan runs with. */
export interface PlanLimits {
  /** Longest video segment one call may cover, in seconds. */
  readonly maxVideoSeconds: number
  /** Shortest video segment one call may request, in seconds. */
  readonly minVideoSeconds: number
  /** Video length used when a node states none, in seconds. */
  readonly videoDefaultDuration: number
  /** Video model for a segment driven by keyframe images. */
  readonly videoModel: string
  /** Video model for a segment with reference images only. */
  readonly videoRefModel: string
  readonly imageModel: string
  readonly speechModel: string
  readonly musicModel: string
}

/** Project frame spec a plan lays keyframes out for. */
export interface PlanSpec {
  readonly aspect?: string
  readonly resolution?: string
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
  /** Audio source and reference edges consumed by music or speech generation. */
  readonly audio: readonly ResolvedInput[]
  readonly firstFrame?: ResolvedInput
  readonly lastFrame?: ResolvedInput
}

/** One node the runner will generate, with what the plan knows about it. */
export interface PlannedGeneration extends PlannedNode {
  /** Storyboard this entry belongs to. */
  readonly storyboard?: CanvasNodeId
  /**
   * Keys this entry waits on before it may start: a plan `ref` for a node created in this run,
   * or an existing node id for one already adopted. Empty or absent means ready at once.
   */
  readonly after?: readonly string[]
}

/** One plan plus the generation entries the runner executes. */
export interface NodePlan extends GenerationPlan {
  readonly entries: readonly PlannedGeneration[]
}

/**
 * Find a tail extracted from the adopted video, never from another candidate.
 * @param document - canvas holding video and tail versions.
 * @param video - segment whose adopted tail is needed.
 * @returns the exact tail input, or undefined until an adopted source has a tail.
 */
export function adoptedTailOf(document: CanvasDocument, video: CanvasNode | undefined): ResolvedInput | undefined {
  const source = video === undefined ? undefined : activeVersionOf(video)
  if (video === undefined || source === undefined) return undefined
  const held = video.tailOf
  if (held?.sourceVersion === source.id) {
    const version = document.nodes
      .find(node => node.id === held.node)
      ?.versions?.find(version => version.id === held.version)
    if (version?.path !== undefined)
      return { node: held.node, version: version.id, path: version.path, role: 'first_frame' }
  }
  const derived = new Set(
    document.edges.filter(edge => edge.kind === 'derivation' && edge.source === video.id).map(edge => edge.target),
  )
  for (const frame of document.nodes) {
    if (frame.type !== 'image' || !derived.has(frame.id)) continue
    const version = frame.versions?.find(
      version =>
        version.path !== undefined &&
        version.inputs?.some(input => input.node === video.id && input.version === source.id) === true,
    )
    if (version?.path !== undefined)
      return { node: frame.id, version: version.id, path: version.path, role: 'first_frame' }
  }
  return undefined
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
    ...(dialogue === '' ? [] : [`台词（${dialogue}）`]),
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

/** `@name` mention for one bible entry id, or the bare id when the bible lacks it. */
function mentionOf(bible: Bible | undefined, id: string): string {
  const entry = bible?.entries.find(candidate => candidate.id === id)
  return `@${entry?.name ?? id}`
}

/**
 * Prompt a keyframe image sends for the first shot it covers: framing, what the frame shows,
 * the people and place as `@name` mentions, and the camera move. Dialogue stays out — the
 * keyframe is a still.
 * @param shot - shot the keyframe opens on.
 * @param bible - bible that names the mentioned entries.
 * @returns the image prompt.
 */
export function keyframePrompt(shot: Shot, bible: Bible | undefined): string {
  const parts = [
    `[${shot.shotSize}] ${shot.visual}`,
    ...(shot.characters.length === 0 ? [] : [`角色：${shot.characters.map(id => mentionOf(bible, id)).join('、')}`]),
    ...(shot.scene === undefined ? [] : [`场景：${mentionOf(bible, shot.scene)}`]),
    ...(shot.props.length === 0 ? [] : [`道具：${shot.props.map(id => mentionOf(bible, id)).join('、')}`]),
    `运镜：${shot.camera}`,
  ]
  return parts.join('。')
}

/** Edges into one node, in a stable order. */
function incoming(document: CanvasDocument, node: CanvasNodeId): readonly CanvasEdge[] {
  return document.edges
    .filter(edge => edge.target === node)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
}

/** File and version one edge's source currently shows. */
function resolveInput(
  document: CanvasDocument,
  edge: CanvasEdge,
  produced?: ReadonlyMap<CanvasNodeId, { readonly version: VersionId; readonly path: string }>,
): ResolvedInput | undefined {
  const source = document.nodes.find(node => node.id === edge.source)
  if (source === undefined) return undefined
  const made = produced?.get(source.id)
  const version =
    made === undefined
      ? activeVersionOf(source)
      : { id: made.version, path: made.path } as ReturnType<typeof activeVersionOf>
  if (version?.path === undefined) {
    if (
      edge.kind === 'reference' &&
      edge.role !== undefined &&
      edge.role !== 'prompt' &&
      (source.type === 'image' || source.type === 'video' || source.type === 'audio')
    ) {
      throw new Error(`Node ${source.id} has no adopted media; adopt a version before using it as ${edge.role}`)
    }
    return undefined
  }
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
function entryReference(
  document: CanvasDocument,
  entry: { readonly imageNodes: readonly string[] },
): ResolvedInput | undefined {
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
 * @param produced - versions this run already generated, keyed by node; a dependent consumes these
 *   instead of the node's possibly-unadopted active version.
 * @returns the prompt, reference images in edge order, and the frame slots.
 */
export function collectInputs(
  document: CanvasDocument,
  node: CanvasNode,
  bible: Bible | undefined,
  produced?: ReadonlyMap<CanvasNodeId, { readonly version: VersionId; readonly path: string }>,
): NodeInputs {
  const edges = incoming(document, node.id)
  const sources = edges.map(edge => ({
    edge,
    source: document.nodes.find(candidate => candidate.id === edge.source),
  }))
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
  const joined = [...textPrompts, ...storyboardPrompts, node.gen?.prompt ?? '']
    .filter(part => part !== '')
    .join('\n\n')
  const prompt = expandMentions(joined, bible)
  const resolved = edges.map(edge => ({
    edge,
    input: resolveInput(document, edge, produced),
  }))
  const edgeRefs = resolved
    .filter(entry => entry.edge.role === 'ref' && entry.input !== undefined)
    .map(entry => entry.input as ResolvedInput)
  const mentioned =
    bible === undefined
      ? []
      : bible.entries
        .filter(
          entry => joined.includes(`@${entry.name}`) || entry.aliases.some(alias => joined.includes(`@${alias}`)),
        )
        .map(entry => entryReference(document, entry))
        .filter((input): input is ResolvedInput => input !== undefined)
  const firstFrame = resolved.find(entry => entry.edge.role === 'first_frame')?.input
  const refs = [...edgeRefs]
  // A video's first frame already carries the mentioned people and place; the frame-driven model
  // accepts no reference images beside it.
  for (const input of node.type === 'video' && firstFrame !== undefined ? [] : mentioned) {
    if (!refs.some(ref => ref.node === input.node)) refs.push(input)
  }
  const lastFrame = resolved.find(entry => entry.edge.role === 'last_frame')?.input
  const audio = resolved
    .filter(
      entry =>
        (entry.edge.role === 'audio' || entry.edge.role === 'source') &&
        document.nodes.some(source => source.id === entry.edge.source && source.type === 'audio'),
    )
    .flatMap(entry => (entry.input === undefined ? [] : [entry.input]))
  return {
    prompt,
    refs,
    audio,
    ...(firstFrame === undefined ? {} : { firstFrame }),
    ...(lastFrame === undefined ? {} : { lastFrame }),
  }
}

/** Shots one segment covers, in storyboard order. */
function shotsOfSegment(shots: readonly Shot[], segment: StoryboardSegment): readonly Shot[] {
  const ids = new Set(segment.shots)
  return shots.filter(shot => ids.has(shot.id))
}

/** Existing video node that already stands for one segment. */
function videoForSegment(
  document: CanvasDocument,
  storyboard: CanvasNodeId,
  segment: StoryboardSegment,
): CanvasNode | undefined {
  const wanted = [...segment.shots].sort().join(',')
  return document.nodes.find(
    node =>
      node.type === 'video' &&
      node.gen?.shot?.storyboard === storyboard &&
      [...node.gen.shot.shots].sort().join(',') === wanted &&
      node.stale !== true,
  )
}

/** Existing keyframe image that already stands for one segment. */
function keyframeForSegment(
  document: CanvasDocument,
  storyboard: CanvasNodeId,
  segment: StoryboardSegment,
): CanvasNode | undefined {
  const wanted = [...segment.shots].sort().join(',')
  return document.nodes.find(
    node =>
      node.type === 'image' &&
      node.gen?.shot?.storyboard === storyboard &&
      [...node.gen.shot.shots].sort().join(',') === wanted &&
      node.stale !== true,
  )
}

/** Whether one node already has an adopted media version to feed a frame slot. */
function hasAdoptedMedia(node: CanvasNode | undefined): boolean {
  return node !== undefined && activeVersionOf(node)?.path !== undefined
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
 * @param spec - project frame spec the keyframes lay out for.
 * @returns the plan, the canvas edits it needs, and the gate that blocks it when one does.
 */
export function planNodes(
  document: CanvasDocument,
  bible: Bible | undefined,
  requested: readonly string[],
  limits: PlanLimits,
  spec?: PlanSpec,
): NodePlan {
  const create: CanvasOperation[] = []
  const edits: CanvasOperation[] = []
  const entries: PlannedGeneration[] = []
  const segments: { storyboard: CanvasNodeId; index: number; shots: readonly string[] }[] = []
  const stale: CanvasNodeId[] = []

  for (const id of requested) {
    const node = document.nodes.find(candidate => candidate.id === id)
    if (node === undefined) throw new Error(`canvas node ${id} does not exist`)
    if (node.status?.state === 'failed' && node.status.recoveryRequired === true) {
      return refused({ gate: 'media_recovery', missing: [node.status.error] })
    }
    if (
      node.type === 'image' ||
      node.type === 'video' ||
      node.type === 'storyboard' ||
      node.gen?.prompt.includes('@') === true
    ) {
      const bibleGate = gateBibleFirst(bible)
      if (bibleGate !== undefined) return refused(bibleGate)
    }
    if (node.type === 'storyboard') {
      const quality = gateStoryboardQuality(document, bible)
      if (quality !== undefined) return refused(quality)
      const shots = activeVersionOf(node)?.shots ?? []
      const plan = planShotSegments(shots, { maxSegmentSec: limits.maxVideoSeconds })
      const keyframeSize =
        spec?.aspect === undefined ? undefined : imagePixelSize(spec.aspect, spec.resolution ?? '')

      // Pass A: one keyframe image per segment. `keyIds[i]`/`vidIds[i]` hold the identifier a
      // plan ref for a node created now or a node id for an existing one; '' means no keyframe.
      // `keyGen[i]` is set when the keyframe must generate this run.
      const keyIds: string[] = []
      const keyGen: ({ node: CanvasNodeId; ref?: string; model: string } | undefined)[] = []
      for (const [index, segment] of plan.segments.entries()) {
        const existingVideo = videoForSegment(document, node.id, segment)
        const covered = shotsOfSegment(shots, segment)
        // A manual first frame (an adopted image that is not this segment's keyframe) means the
        // segment needs no generated keyframe; an edge to the keyframe itself still manages it.
        const frameSource = existingVideo === undefined
          ? undefined
          : incoming(document, existingVideo.id).find(edge => edge.role === 'first_frame')?.source
        const frameNode = frameSource === undefined
          ? undefined
          : document.nodes.find(candidate => candidate.id === frameSource)
        const manualFrame =
          frameNode !== undefined &&
          !(frameNode.type === 'image' && frameNode.gen?.shot?.storyboard === node.id &&
            [...frameNode.gen.shot.shots].sort().join(',') === [...segment.shots].sort().join(','))
        let keyId = ''
        let gen: { node: CanvasNodeId; ref?: string; model: string } | undefined
        if (!manualFrame && covered.length > 0) {
          const existingKey = keyframeForSegment(document, node.id, segment)
          const prompt = keyframePrompt(covered[0] as Shot, bible)
          if (existingKey === undefined) {
            const keyRef = `keyframe-${node.id}-${String(index)}`
            create.push({
              op: 'add',
              ref: keyRef,
              type: 'image',
              title: `${node.title} · 段${String(index + 1)} 分镜图`,
              gen: {
                kind: 'image',
                prompt,
                model: limits.imageModel,
                params: keyframeSize === undefined ? {} : { size: keyframeSize },
                shot: { storyboard: node.id, shots: segment.shots },
              },
            })
            keyId = keyRef
            gen = { node: keyRef as CanvasNodeId, ref: keyRef, model: limits.imageModel }
          } else {
            keyId = existingKey.id
            const adopted = hasAdoptedMedia(existingKey)
            const drift = existingKey.gen?.prompt !== prompt
            if (drift) edits.push({ op: 'set_gen', node: existingKey.id, gen: { prompt } })
            if (!adopted || drift) {
              gen = { node: existingKey.id, model: existingKey.gen?.model ?? limits.imageModel }
            }
          }
        }
        keyIds[index] = keyId
        keyGen[index] = gen
      }
      const firstKey = keyIds[0]

      // Pass B: videos always regenerate; entries carry their dependency lists.
      const vidIds: string[] = []
      const tailAllowed: boolean[] = []
      for (const [index, segment] of plan.segments.entries()) {
        const existingVideo = videoForSegment(document, node.id, segment)
        const covered = shotsOfSegment(shots, segment)
        const videoPrompt = segmentPrompt(covered, bible)
        const videoRef = `segment-${node.id}-${String(index)}`
        const model = limits.videoModel
        const keyId = keyIds[index]
        const nextKey = keyIds[index + 1]
        const usesLastFrame =
          index + 1 < plan.segments.length &&
          plan.segments[index + 1]?.needsTailChain === true &&
          existingVideo?.gen?.tailChain !== false &&
          nextKey !== undefined &&
          nextKey !== ''
        const after = [
          ...(keyId !== undefined && keyId !== '' ? [keyId] : []),
          ...(usesLastFrame ? [nextKey] : []),
        ]
        const chosen: PlannedGeneration = {
          node: (existingVideo?.id ?? videoRef) as CanvasNodeId,
          ...(existingVideo === undefined ? { ref: videoRef } : {}),
          kind: 'video',
          model: existingVideo?.gen?.model ?? model,
          calls: 1,
          lines: 1,
          seconds: Math.max(limits.minVideoSeconds, Math.min(segment.durationSec, limits.maxVideoSeconds)),
          shots: covered.map(shot => shot.title),
          storyboard: node.id,
          ...(after.length === 0 ? {} : { after }),
        }
        if (existingVideo === undefined) {
          create.push({
            op: 'add',
            ref: videoRef,
            type: 'video',
            title: `${node.title} · 段${String(index + 1)}`,
            gen: {
              kind: 'video',
              prompt: videoPrompt,
              model,
              params: { duration: Number(chosen.seconds) },
              shot: { storyboard: node.id, shots: segment.shots },
            },
          })
        } else if (existingVideo.gen?.prompt !== videoPrompt) {
          edits.push({ op: 'set_gen', node: existingVideo.id, gen: { prompt: videoPrompt } })
        }
        entries.push(chosen)
        vidIds[index] = existingVideo?.id ?? videoRef
        tailAllowed[index] = existingVideo?.gen?.tailChain !== false
        segments.push({ storyboard: node.id, index, shots: segment.shots })

        // The segment's keyframe entry, when it must generate, waits on the scene's first keyframe.
        const gen = keyGen[index]
        if (gen !== undefined) {
          const keyAfter = index > 0 && firstKey !== undefined && firstKey !== '' ? [firstKey] : []
          entries.push({
            node: gen.node,
            ...(gen.ref === undefined ? {} : { ref: gen.ref }),
            kind: 'image',
            model: gen.model,
            calls: 1,
            lines: 0,
            storyboard: node.id,
            ...(keyAfter.length === 0 ? {} : { after: keyAfter }),
          })
        }
      }

      // Pass C: frame edges. K0 feeds every later keyframe as a ref; Ki feeds Vi as first_frame;
      // K(i+1) feeds Vi as last_frame only for a continuous next segment the video did not opt out of.
      const link = (from: string, to: string, role: CanvasEdgeRole, order?: number): void => {
        create.push({ op: 'connect', from, to, kind: 'reference', role, ...(order === undefined ? {} : { order }) })
      }
      for (const [index, keyId] of keyIds.entries()) {
        if (keyId === '') continue
        if (index > 0 && firstKey !== undefined && firstKey !== '') link(firstKey, keyId, 'ref', 0)
        const videoId = vidIds[index]
        if (videoId !== undefined) link(keyId, videoId, 'first_frame')
        const nextSegment = plan.segments[index + 1]
        if (
          nextSegment !== undefined &&
          nextSegment.needsTailChain &&
          tailAllowed[index] === true &&
          vidIds[index] !== undefined
        ) {
          const nextKey = keyIds[index + 1]
          if (nextKey !== undefined && nextKey !== '') link(nextKey, vidIds[index], 'last_frame')
        }
      }
      for (const candidate of document.nodes) {
        if (
          (candidate.type !== 'video' && candidate.type !== 'image') ||
          candidate.gen?.shot?.storyboard !== node.id ||
          candidate.stale === true
        )
          continue
        const wanted = [...candidate.gen.shot.shots].sort().join(',')
        if (!plan.segments.some(segment => [...segment.shots].sort().join(',') === wanted)) stale.push(candidate.id)
      }
      continue
    }
    if (node.gen === undefined || (node.type !== 'image' && node.type !== 'video' && node.type !== 'audio')) {
      throw new Error(`canvas node ${node.id} does not generate media`)
    }
    if (node.type === 'video') {
      if (node.gen.shot !== undefined) {
        const board = document.nodes.find(
          candidate => candidate.id === node.gen?.shot?.storyboard && candidate.type === 'storyboard',
        )
        if (board === undefined)
          return refused({
            gate: 'G2_storyboard_quality',
            missing: [`${node.id} storyboard ${node.gen.shot.storyboard} does not exist`],
          })
        const shots = new Set((activeVersionOf(board)?.shots ?? []).map(shot => shot.id))
        const missing = node.gen.shot.shots.filter(shot => !shots.has(shot))
        if (missing.length > 0)
          return refused({
            gate: 'G2_storyboard_quality',
            missing: missing.map(shot => `${board.id} shot ${shot} does not exist`),
          })
      }
      const boards = new Set([
        ...(node.gen.shot === undefined ? [] : [node.gen.shot.storyboard]),
        ...incoming(document, node.id)
          .filter(edge => edge.role === 'prompt')
          .map(edge => edge.source),
      ])
      const quality = gateStoryboardQuality(
        {
          ...document,
          nodes: document.nodes.filter(candidate => candidate.type !== 'storyboard' || boards.has(candidate.id)),
        },
        bible,
      )
      if (quality !== undefined) return refused(quality)
    }
    // A lone segment video still needs its keyframes: its own, the scene's first when it is not
    // segment 0, and the next segment's when continuity calls for a last frame.
    const after: string[] = []
    if (node.type === 'video' && node.gen.shot !== undefined) {
      const shotRef = node.gen.shot
      const board = document.nodes.find(candidate => candidate.id === shotRef.storyboard)
      const boardShots = board === undefined ? [] : (activeVersionOf(board)?.shots ?? [])
      const ordered = planShotSegments(boardShots, { maxSegmentSec: limits.maxVideoSeconds }).segments
      const wanted = [...shotRef.shots].sort().join(',')
      const position = ordered.findIndex(segment => [...segment.shots].sort().join(',') === wanted)
      const keyframeSize =
        spec?.aspect === undefined ? undefined : imagePixelSize(spec.aspect, spec.resolution ?? '')
      // Keyframes this video consumes: its own segment's, the scene root's when it is not first,
      // and the next segment's when that segment continues this one.
      const needed = new Set<number>()
      if (position >= 0) {
        needed.add(position)
        if (position > 0) needed.add(0)
        const next = ordered[position + 1]
        if (next?.needsTailChain === true && node.gen.tailChain !== false) needed.add(position + 1)
      }
      const keyIds = new Map<number, string>()
      for (const index of [...needed].sort((a, b) => a - b)) {
        const segment = ordered[index]
        if (segment === undefined) continue
        const covered = shotsOfSegment(boardShots, segment)
        const existingKey = keyframeForSegment(document, shotRef.storyboard, segment)
        const videoNode = videoForSegment(document, shotRef.storyboard, segment)
        const frameSource = videoNode === undefined
          ? undefined
          : incoming(document, videoNode.id).find(edge => edge.role === 'first_frame')?.source
        const frameNode = frameSource === undefined
          ? undefined
          : document.nodes.find(candidate => candidate.id === frameSource)
        const manualFrame =
          frameNode !== undefined &&
          !(frameNode.type === 'image' && frameNode.gen?.shot?.storyboard === shotRef.storyboard &&
            [...frameNode.gen.shot.shots].sort().join(',') === [...segment.shots].sort().join(','))
        let keyId = ''
        if (!manualFrame && covered.length > 0) {
          const prompt = keyframePrompt(covered[0] as Shot, bible)
          if (existingKey === undefined) {
            const keyRef = `keyframe-${shotRef.storyboard}-${String(index)}`
            create.push({
              op: 'add',
              ref: keyRef,
              type: 'image',
              title: `${board?.title ?? shotRef.storyboard} · 段${String(index + 1)} 分镜图`,
              gen: {
                kind: 'image',
                prompt,
                model: limits.imageModel,
                params: keyframeSize === undefined ? {} : { size: keyframeSize },
                shot: { storyboard: shotRef.storyboard, shots: segment.shots },
              },
            })
            keyId = keyRef
            const keyAfter = index > 0 && keyIds.get(0) !== undefined ? [keyIds.get(0) as string] : []
            entries.push({
              node: keyRef as CanvasNodeId,
              ref: keyRef,
              kind: 'image',
              model: limits.imageModel,
              calls: 1,
              lines: 0,
              storyboard: shotRef.storyboard,
              ...(keyAfter.length === 0 ? {} : { after: keyAfter }),
            })
          } else {
            keyId = existingKey.id
            const adopted = hasAdoptedMedia(existingKey)
            const drift = existingKey.gen?.prompt !== prompt
            if (drift) edits.push({ op: 'set_gen', node: existingKey.id, gen: { prompt } })
            if (!adopted || drift) {
              const keyAfter = index > 0 && keyIds.get(0) !== undefined ? [keyIds.get(0) as string] : []
              entries.push({
                node: existingKey.id,
                kind: 'image',
                model: existingKey.gen?.model ?? limits.imageModel,
                calls: 1,
                lines: 0,
                storyboard: shotRef.storyboard,
                ...(keyAfter.length === 0 ? {} : { after: keyAfter }),
              })
            }
          }
        }
        keyIds.set(index, keyId)
        // Edges this keyframe participates in for THIS video only.
        if (index === position && keyId !== '') {
          create.push({ op: 'connect', from: keyId, to: node.id, kind: 'reference', role: 'first_frame' })
          after.push(keyId)
        }
        if (index === position + 1 && keyId !== '' && node.gen.tailChain !== false) {
          create.push({ op: 'connect', from: keyId, to: node.id, kind: 'reference', role: 'last_frame' })
          after.push(keyId)
        }
        if (index > 0 && keyId !== '' && keyIds.get(0) !== undefined && keyIds.get(0) !== '') {
          create.push({ op: 'connect', from: keyIds.get(0) as string, to: keyId, kind: 'reference', role: 'ref', order: 0 })
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
      ...(after.length === 0 ? {} : { after }),
      ...(node.gen.kind === 'video'
        ? { seconds: Number(node.gen.params.duration ?? limits.videoDefaultDuration) }
        : {}),
      ...(node.gen.kind === 'speech' ? { lines: 1 } : {}),
    })
  }

  return { nodes: entries, create, ...(edits.length === 0 ? {} : { edits }), stale, segments, entries }
}
