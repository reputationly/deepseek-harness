/**
 * Executing one generation plan: apply the canvas edits the plan needs, run each node as a media
 * job, append the versions it produced, and keep the node status in step with the job.
 * @module
 */

import {
  type Bible, type CanvasDocument, type CanvasEditResult, type CanvasNode, type CanvasNodeId, type CanvasOperation,
  type NodeInput, type NodeVersion,
} from '@deepseek-ai/dsh-canvas'
import { budgetOf, type Budget, type ConfirmLimits } from './budget.ts'
import { collectInputs, planNodes, type NodePlan, type PlanLimits, type PlannedGeneration } from './node-runner.ts'

/** One media file a generator produced, with the numbers a version records. */
export interface GeneratedMedia {
  readonly path: string
  readonly model: string
  readonly durationMs?: number
  readonly width?: number
  readonly height?: number
}

/** What one generation call needs, resolved from the canvas at run time. */
export interface MediaCall {
  readonly node: CanvasNode
  readonly entry: PlannedGeneration
  /** Prompt with prompt edges and mentions already expanded. */
  readonly prompt: string
  /** Reference image files, in edge order. */
  readonly refs: readonly string[]
  /** File a tail chain uses as the first frame, when the plan resolved one. */
  readonly firstFramePath?: string
  readonly lastFramePath?: string
  /** Project frame ratio, such as `9:16`. */
  readonly aspectRatio?: string
  /** Project output resolution tier, such as `1080p`. */
  readonly resolution?: string
  readonly signal: AbortSignal
}

/** Generators the runner calls, one per media kind. */
export interface MediaGenerator {
  image(call: MediaCall): Promise<GeneratedMedia>
  video(call: MediaCall): Promise<GeneratedMedia>
  speech(call: MediaCall): Promise<GeneratedMedia>
  music(call: MediaCall): Promise<GeneratedMedia>
}

/** One job the runner registered for a node. */
export interface MediaJob {
  readonly id: string
  readonly done: Promise<GeneratedMedia>
}

/** Canvas reads and writes the runner needs. */
export interface RunnerCanvas {
  read(): Promise<{ readonly document: CanvasDocument; readonly revision: number }>
  bible(): Promise<Bible | undefined>
  edit(operations: readonly CanvasOperation[], baseRevision: number): Promise<CanvasEditResult>
}

/** Everything the runner calls outside its own planning. */
export interface RunnerServices {
  readonly canvas: RunnerCanvas
  /** Project spec every generation follows. */
  readonly spec?: { readonly aspect?: string; readonly resolution?: string }
  readonly limits: PlanLimits
  readonly confirmLimits: ConfirmLimits
  /** Media jobs this call may run at once. */
  readonly concurrency: number
  readonly generate: MediaGenerator
  readonly jobs: { start(spec: { readonly label: string; readonly run: (signal: AbortSignal) => Promise<GeneratedMedia> }): MediaJob }
  /** Probe a media file for duration and picture size. */
  readonly probe: (path: string) => Promise<{ readonly durationMs?: number; readonly width?: number; readonly height?: number }>
  /** Extract the last frame of a video into an image file. */
  readonly tailFrame: (path: string) => Promise<string>
  readonly now: () => string
}

/** Outcome of one generation call. */
export interface NodeRunResult {
  readonly node: CanvasNodeId
  readonly ok: boolean
  /** Job registered for the node. */
  readonly jobId?: string
  readonly path?: string
  readonly error?: string
  readonly retryable?: boolean
}

/** Outcome of one run. */
export type RunOutcome =
  | { readonly status: 'blocked'; readonly plan: NodePlan }
  | { readonly status: 'needs_confirmation'; readonly plan: NodePlan; readonly budget: Budget }
  | { readonly status: 'done'; readonly plan: NodePlan; readonly results: readonly NodeRunResult[] }

/** Node the plan's reference created, when it created one. */
function nodeIdOf(entry: PlannedGeneration, refs: CanvasEditResult['refs']): CanvasNodeId {
  return entry.ref === undefined ? entry.node : refs[entry.ref] ?? entry.node
}

/** Run promises with a ceiling on how many are in flight. */
async function pool<T>(tasks: readonly (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    for (;;) {
      const index = next
      next += 1
      const task = tasks[index]
      if (task === undefined) return
      results[index] = await task()
    }
  })
  await Promise.all(workers)
  return results
}

/** Version body one successful call records. */
function versionOf(
  media: GeneratedMedia,
  call: {
    readonly prompt: string
    readonly params: Readonly<Record<string, string | number | boolean>>
    readonly inputs: readonly NodeInput[]
    readonly createdAt: string
  },
): Omit<NodeVersion, 'id'> {
  return {
    createdAt: call.createdAt,
    origin: 'agent',
    path: media.path,
    prompt: call.prompt,
    model: media.model,
    params: call.params,
    inputs: call.inputs,
    ...media.durationMs === undefined ? {} : { durationMs: media.durationMs },
    ...media.width === undefined ? {} : { width: media.width },
    ...media.height === undefined ? {} : { height: media.height },
  }
}

/** NodeInput list for the files one call consumed. */
function inputsOf(inputs: ReturnType<typeof collectInputs>): readonly NodeInput[] {
  const one = (input: {
    readonly node: CanvasNodeId
    readonly version: string
    readonly role: NonNullable<NodeInput['role']>
    readonly path: string
  }): NodeInput => ({ node: input.node, version: input.version as never, role: input.role, path: input.path })
  return [
    ...inputs.refs.map(one),
    ...inputs.firstFrame === undefined ? [] : [one(inputs.firstFrame)],
    ...inputs.lastFrame === undefined ? [] : [one(inputs.lastFrame)],
  ]
}

/**
 * Run one generation plan.
 * @param services - canvas access, generators, jobs, and deployment bounds.
 * @param requested - node ids to generate.
 * @param token - budget token the caller confirmed, when it confirmed one.
 * @returns the refusal, the budget the caller must confirm, or what each node produced.
 */
export async function runPlan(
  services: RunnerServices,
  requested: readonly string[],
  token: string | undefined,
  options: { readonly skipConfirmation?: boolean } = {},
): Promise<RunOutcome> {
  const loaded = await services.canvas.read()
  const bible = await services.canvas.bible()
  const plan = planNodes(loaded.document, bible, requested, services.limits)
  if (plan.blocked !== undefined) return { status: 'blocked', plan }
  const budget = budgetOf(plan, services.confirmLimits)
  if (budget.needsConfirmation && budget.token !== token && options.skipConfirmation !== true) {
    return { status: 'needs_confirmation', plan, budget }
  }

  let document = loaded.document
  let revision = loaded.revision
  const edits: CanvasOperation[] = [
    ...plan.create,
    ...plan.stale.map(node => ({ op: 'set_stale' as const, node, stale: true })),
  ]
  let refs: CanvasEditResult['refs'] = {}
  if (edits.length > 0) {
    const edit = await services.canvas.edit(edits, revision)
    refs = edit.refs
    const reread = await services.canvas.read()
    document = reread.document
    revision = reread.revision
  }

  const entries = plan.entries.map(entry => ({ entry, node: nodeIdOf(entry, refs) }))
  const groups = new Map<string, typeof entries>()
  for (const item of entries) {
    const key = item.entry.storyboard === undefined ? `node:${String(item.node)}` : `board:${String(item.entry.storyboard)}`
    groups.set(key, [...groups.get(key) ?? [], item])
  }

  const results: NodeRunResult[] = []
  const runGroup = async (group: typeof entries): Promise<void> => {
    let previousTail: { readonly node: CanvasNodeId; readonly path: string } | undefined
    for (const { entry, node } of group) {
      document = (await services.canvas.read()).document
      const current = document.nodes.find(candidate => candidate.id === node)
      if (current === undefined) {
        results.push({ node, ok: false, error: `node ${String(node)} disappeared before it could generate`, retryable: false })
        continue
      }
      const inputs = collectInputs(document, current, bible)
      const tail = entry.tailChain === undefined
        ? undefined
        : document.nodes.find(candidate => candidate.id === entry.tailChain?.node)
          ?.versions?.find(version => version.id === entry.tailChain?.version)
      let firstFramePath = entry.tailChain === undefined ? inputs.firstFrame?.path : tail?.path
      if (entry.chain === true && firstFramePath === undefined && previousTail !== undefined) {
        revision = (await services.canvas.edit([
          { op: 'connect', from: previousTail.node, to: node, kind: 'reference', role: 'first_frame' },
        ], revision)).revision
        document = (await services.canvas.read()).document
        firstFramePath = previousTail.path
      }
      const missingRefs = inputs.refs.filter(ref => !document.edges.some(edge => edge.source === ref.node
        && edge.target === node && edge.role === 'ref'))
      if (missingRefs.length > 0) {
        revision = (await services.canvas.edit(missingRefs.map((ref, order) => ({
          op: 'connect' as const, from: ref.node, to: node, kind: 'reference' as const, role: 'ref' as const, order,
        })), revision)).revision
        document = (await services.canvas.read()).document
      }
      const job = services.jobs.start({
        label: `${current.title}`,
        run: signal => generate(services, current, entry, {
          prompt: inputs.prompt,
          refs: inputs.refs.map(ref => ref.path),
          ...firstFramePath === undefined ? {} : { firstFramePath },
          ...inputs.lastFrame === undefined ? {} : { lastFramePath: inputs.lastFrame.path },
        }, signal),
      })
      const queued: CanvasOperation = {
        op: 'set_status', node, status: { state: 'queued', jobId: job.id as never, at: services.now() },
      }
      revision = (await services.canvas.edit([queued], revision)).revision
      try {
        const media = await job.done
        const probe = media.durationMs === undefined && current.type === 'video' ? await services.probe(media.path) : {}
        const recorded: GeneratedMedia = { ...media, ...probe }
        revision = (await services.canvas.edit([
          {
            op: 'append_version',
            node,
            version: versionOf(recorded, {
              prompt: inputs.prompt,
              params: { duration: Number(entry.seconds ?? 0) },
              inputs: inputsOf(inputs),
              createdAt: services.now(),
            }),
          },
          { op: 'set_status', node, status: null },
        ], revision)).revision
        revision = (await services.canvas.read()).revision
        if (current.type === 'video') {
          const tail = await recordTail(services, node, media.path, revision)
          if (tail !== undefined) previousTail = tail
          revision = (await services.canvas.read()).revision
        }
        results.push({ node, ok: true, jobId: job.id, path: media.path })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        revision = (await services.canvas.edit([{
          op: 'set_status', node, status: { state: 'failed', at: services.now(), error: message, retryable: true },
        }], revision)).revision
        results.push({ node, ok: false, jobId: job.id, error: message, retryable: true })
      }
    }
  }
  await pool([...groups.values()].map(group => () => runGroup(group)), services.concurrency)
  return { status: 'done', plan, results }
}

/** Call the generator that matches one node. */
async function generate(
  services: RunnerServices,
  node: CanvasNode,
  entry: PlannedGeneration,
  resolved: Pick<MediaCall, 'prompt' | 'refs' | 'firstFramePath' | 'lastFramePath'>,
  signal: AbortSignal,
): Promise<GeneratedMedia> {
  const call: MediaCall = {
    node, entry, signal, ...resolved,
    ...services.spec?.aspect === undefined ? {} : { aspectRatio: services.spec.aspect },
    ...services.spec?.resolution === undefined ? {} : { resolution: services.spec.resolution },
  }
  if (entry.kind === 'image') return services.generate.image(call)
  if (entry.kind === 'video') return services.generate.video(call)
  if (entry.kind === 'speech') return services.generate.speech(call)
  return services.generate.music(call)
}

/** Store the last frame of a finished video as an image node and record it on the video. */
async function recordTail(
  services: RunnerServices,
  video: CanvasNodeId,
  path: string,
  revision: number,
): Promise<{ readonly node: CanvasNodeId; readonly path: string } | undefined> {
  const tailPath = await services.tailFrame(path)
  const edit = await services.canvas.edit([
    { op: 'add', ref: 'tail', type: 'image', title: `${video} · 尾帧`, path: tailPath },
  ], revision)
  const tailId = edit.refs.tail
  if (tailId === undefined) return undefined
  await services.canvas.edit([
    { op: 'connect', from: video, to: tailId, kind: 'derivation' },
    { op: 'set_tail', node: video, tailOf: { node: tailId, version: 'v1' as never } },
  ], (await services.canvas.read()).revision)
  return { node: tailId, path: tailPath }
}
