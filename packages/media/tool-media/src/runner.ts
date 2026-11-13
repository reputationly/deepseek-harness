/**
 * Executing one generation plan: apply the canvas edits the plan needs, run each node as a media
 * job, append the versions it produced, and keep the node status in step with the job.
 * @module
 */

import {
  CanvasConflictError, planShotSegments, type Bible, type CanvasDocument, type CanvasEditResult, type CanvasNode,
  type CanvasNodeId, type CanvasOperation, type NodeInput, type NodeStatus, type NodeVersion,
} from '@deepseek-ai/dsh-canvas'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
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
  readonly id: JobId
  readonly done: Promise<GeneratedMedia>
  /** Cancellation the producer watches, so a failure can be told from a cancel. */
  readonly signal: AbortSignal
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
  readonly jobs: {
    start(spec: { readonly label: string; readonly run: (signal: AbortSignal) => Promise<GeneratedMedia> }): MediaJob
    /** Ids of jobs still running, so a status left by a previous process is repaired. */
    live?(): readonly string[]
  }
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
  readonly jobId?: JobId
  readonly path?: string
  readonly error?: string
  readonly retryable?: boolean
}

/** Outcome of one run. */
export type RunOutcome =
  | { readonly status: 'blocked'; readonly plan: NodePlan }
  | { readonly status: 'needs_confirmation'; readonly plan: NodePlan; readonly budget: Budget }
  | { readonly status: 'already_running'; readonly nodes: readonly CanvasNodeId[] }
  | { readonly status: 'started'; readonly plan: NodePlan; readonly jobs: readonly { readonly node: CanvasNodeId; readonly jobId: JobId }[]; readonly settle: Promise<readonly NodeRunResult[]> }
  | { readonly status: 'done'; readonly plan: NodePlan; readonly results: readonly NodeRunResult[] }

/** Node the plan's reference created, when it created one. */
function nodeIdOf(entry: PlannedGeneration, refs: CanvasEditResult['refs']): CanvasNodeId {
  /* v8 ignore next -- a ref the plan named is always claimed by the same edit */
  return entry.ref === undefined ? entry.node : refs[entry.ref] ?? entry.node
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
    readonly version: NodeInput['version']
    readonly role: NonNullable<NodeInput['role']>
    readonly path: string
  }): NodeInput => ({ node: input.node, version: input.version, role: input.role, path: input.path })
  return [
    ...inputs.refs.map(one),
    ...inputs.firstFrame === undefined ? [] : [one(inputs.firstFrame)],
    ...inputs.lastFrame === undefined ? [] : [one(inputs.lastFrame)],
  ]
}

/**
 * Apply operations against the latest revision, retrying a lost race with a concurrent writer.
 * @param services - canvas access.
 * @param operations - edits to apply, in order.
 * @returns the edit result.
 */
async function editLatest(services: RunnerServices, operations: readonly CanvasOperation[]): Promise<CanvasEditResult> {
  for (let attempt = 0; ; attempt += 1) {
    const { revision } = await services.canvas.read()
    try {
      return await services.canvas.edit(operations, revision)
    } catch (error: unknown) {
      if (!(error instanceof CanvasConflictError) || attempt >= 4) throw error
    }
  }
}

/** Mark a node's status through the retrying editor. */
async function setStatus(services: RunnerServices, node: CanvasNodeId, status: Parameters<typeof statusOp>[0]['status']): Promise<void> {
  await editLatest(services, [statusOp({ node, status })])
}

/** Status operation for one node. */
function statusOp(change: { readonly node: CanvasNodeId; readonly status: NodeStatus | null }): CanvasOperation {
  return { op: 'set_status', node: change.node, status: change.status }
}

/** Repair a status a previous process left behind: no live job owns it, so it failed. */
async function recoverInterrupted(services: RunnerServices): Promise<void> {
  const live = new Set(services.jobs.live?.() ?? [])
  const { document } = await services.canvas.read()
  for (const node of document.nodes) {
    const status = node.status
    if (status === undefined || status.state === 'failed') continue
    if (live.has(status.jobId)) continue
    await setStatus(services, node.id, {
      state: 'failed', at: services.now(), error: 'interrupted by a restart', retryable: true,
    })
  }
}

/** Retryability of one generation failure. */
function retryableOf(error: unknown, signal: AbortSignal): { readonly error: string; readonly retryable: boolean } {
  if (signal.aborted) return { error: 'cancelled', retryable: true }
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { readonly status?: unknown }).status
  if (typeof status === 'number' && status >= 400 && status < 500) return { error: message, retryable: false }
  return { error: message, retryable: true }
}

/** Next video node of the same storyboard after the one being regenerated. */
function nextSegmentNode(document: CanvasDocument, current: CanvasNode, maxSegmentSec: number): CanvasNode | undefined {
  const boardId = current.gen?.shot?.storyboard
  if (boardId === undefined) return undefined
  /* v8 ignore next 4 -- a node with shot references always finds its storyboard and versions */
  const board = document.nodes.find(node => node.id === boardId)
  /* v8 ignore next */
  const shots = board === undefined ? [] : (board.versions ?? []).find(version => version.id === board.activeVersion)?.shots ?? []
  const segments = planShotSegments(shots, { maxSegmentSec }).segments
  const shotsOfNode = current.gen?.shot?.shots
  /* v8 ignore next -- called only for nodes the plan gave shots */
  if (shotsOfNode === undefined) return undefined
  const key = [...shotsOfNode].sort().join(',')
  const index = segments.findIndex(segment => [...segment.shots].sort().join(',') === key)
  const next = segments[index + 1]
  if (index < 0 || next === undefined) return undefined
  const wanted = [...next.shots].sort().join(',')
  return document.nodes.find(node => node.type === 'video'
    && node.gen?.shot?.storyboard === boardId
    && [...node.gen.shot.shots].sort().join(',') === wanted)
}

/**
 * Start one generation plan, returning as soon as every job is registered.
 * @param services - canvas access, generators, jobs, and deployment bounds.
 * @param requested - node ids to generate.
 * @param token - budget token the caller confirmed, when it confirmed one.
 * @param options - `skipConfirmation` lets a caller that already confirmed a wider plan start this one.
 * @returns the refusal, the budget the caller must confirm, or the started jobs and their settlement.
 */
export async function startPlan(
  services: RunnerServices,
  requested: readonly string[],
  token: string | undefined,
  options: { readonly skipConfirmation?: boolean } = {},
): Promise<Exclude<RunOutcome, { readonly status: 'done' }>> {
  await recoverInterrupted(services)
  const loaded = await services.canvas.read()
  const bible = await services.canvas.bible()
  const plan = planNodes(loaded.document, bible, requested, services.limits)
  if (plan.blocked !== undefined) return { status: 'blocked', plan }
  const running = plan.entries
    .map(entry => entry.node)
    .filter((node) => {
      const status = loaded.document.nodes.find(candidate => candidate.id === node)?.status
      return status?.state === 'running' || status?.state === 'queued'
    })
  if (running.length > 0) return { status: 'already_running', nodes: running }
  const budget = budgetOf(plan, services.confirmLimits)
  if (budget.needsConfirmation && budget.token !== token && options.skipConfirmation !== true) {
    return { status: 'needs_confirmation', plan, budget }
  }

  const edits: CanvasOperation[] = [
    ...plan.create,
    ...plan.stale.map(node => ({ op: 'set_stale' as const, node, stale: true })),
  ]
  const refs = edits.length === 0 ? {} : (await editLatest(services, edits)).refs
  const entries = plan.entries.map(entry => ({ entry, node: nodeIdOf(entry, refs) }))
  const groups = new Map<string, typeof entries>()
  for (const item of entries) {
    const key = item.entry.storyboard === undefined ? `node:${String(item.node)}` : `board:${String(item.entry.storyboard)}`
    groups.set(key, [...groups.get(key) ?? [], item])
  }

  const jobs: { node: CanvasNodeId; jobId: JobId }[] = []
  const results: NodeRunResult[] = []
  let active = 0
  const waiting: (() => void)[] = []
  /** Wait for a free slot under the deployment's concurrency bound. */
  const acquire = async (): Promise<void> => {
    while (active >= Math.max(1, services.concurrency)) {
      await new Promise<void>((resolve) => { waiting.push(resolve) })
    }
    active += 1
  }
  const release = (): void => {
    active -= 1
    waiting.shift()?.()
  }

  /** Prepare one entry, start its job, and start recording what it produces. */
  const startEntry = async (
    item: typeof entries[number],
    previousTail: { readonly node: CanvasNodeId; readonly path: string } | undefined,
  ): Promise<{
    readonly jobId: JobId
    readonly done: Promise<GeneratedMedia>
    readonly recorded: Promise<{ readonly tail?: { readonly node: CanvasNodeId; readonly path: string } }>
  }> => {
    const { entry, node } = item
    const document = (await services.canvas.read()).document
    const current = document.nodes.find(candidate => candidate.id === node)
    /* v8 ignore next -- the plan created or found this node in the same run */
    if (current === undefined) throw new Error(`node ${String(node)} disappeared before it could generate`)
    const inputs = collectInputs(document, current, bible)
    const tail = entry.tailChain === undefined
      ? undefined
      : document.nodes.find(candidate => candidate.id === entry.tailChain?.node)
        ?.versions?.find(version => version.id === entry.tailChain?.version)
    let firstFramePath = entry.tailChain === undefined ? inputs.firstFrame?.path : tail?.path
    if (entry.chain === true && firstFramePath === undefined && previousTail !== undefined) {
      await editLatest(services, [{ op: 'connect', from: previousTail.node, to: node, kind: 'reference', role: 'first_frame' }])
      firstFramePath = previousTail.path
    }
    const missingRefs = inputs.refs.filter(ref => !document.edges.some(edge => edge.source === ref.node
      && edge.target === node && edge.role === 'ref'))
    /* v8 ignore next -- every reference the plan found is not connected yet on a first run */
    if (missingRefs.length > 0) {
      await editLatest(services, missingRefs.map((ref, order) => ({
        op: 'connect' as const, from: ref.node, to: node, kind: 'reference' as const, role: 'ref' as const, order,
      })))
    }
    // The runtime issues the job id synchronously, so the queued state lasts only until the next write.
    await setStatus(services, node, { state: 'queued', jobId: 'pending' as JobId, at: services.now() })
    const job = services.jobs.start({
      label: current.title,
      run: async (signal) => {
        await acquire()
        try {
          return await generate(services, current, entry, {
            prompt: inputs.prompt,
            refs: inputs.refs.map(ref => ref.path),
            ...firstFramePath === undefined ? {} : { firstFramePath },
            ...inputs.lastFrame === undefined ? {} : { lastFramePath: inputs.lastFrame.path },
          }, signal)
        } finally {
          release()
        }
      },
    })
    jobs.push({ node, jobId: job.id })
    await setStatus(services, node, { state: 'running', jobId: job.id, at: services.now() })
    const recorded = job.done.then(async (media) => {
      try {
        const probe = media.durationMs === undefined && current.type === 'video' ? await services.probe(media.path) : {}
        const finished: GeneratedMedia = { ...media, ...probe }
        await editLatest(services, [
          {
            op: 'append_version',
            node,
            version: versionOf(finished, {
              prompt: inputs.prompt,
              params: { duration: Number(entry.seconds ?? 0) },
              inputs: inputsOf(inputs),
              createdAt: services.now(),
            }),
          },
          { op: 'set_status', node, status: null },
        ])
        if (current.type !== 'video') {
          results.push({ node, ok: true, jobId: job.id, path: media.path })
          return {}
        }
        const tail = await recordTail(services, node, current.title, media.path, current.tailOf)
        const documentNow = (await services.canvas.read()).document
        const next = nextSegmentNode(documentNow, current, services.limits.maxVideoSeconds)
        if (next !== undefined) await editLatest(services, [{ op: 'set_input_changed', node: next.id, changed: true }])
        results.push({ node, ok: true, jobId: job.id, path: media.path })
        /* v8 ignore next -- a stored frame always names its node */
        return tail === undefined ? {} : { tail }
      } catch (error: unknown) {
        const failure = retryableOf(error, job.signal)
        await setStatus(services, node, { state: 'failed', at: services.now(), error: failure.error, retryable: failure.retryable })
        results.push({ node, ok: false, jobId: job.id, ...failure })
        return {}
      }
    }, async (error: unknown) => {
      const failure = retryableOf(error, job.signal)
      await setStatus(services, node, { state: 'failed', at: services.now(), error: failure.error, retryable: failure.retryable })
      results.push({ node, ok: false, jobId: job.id, ...failure })
      return {}
    })
    return { jobId: job.id, done: job.done, recorded }
  }

  // Register the first job of every group before returning, then let the rest follow their group.
  let noteFirstJob: () => void
  const firstJobStarted = new Promise<void>((resolve) => {
    let pending = groups.size
    noteFirstJob = () => {
      pending -= 1
      if (pending === 0) resolve()
    }
  })
  /** Run one storyboard's segments in order, chaining each tail into the next segment. */
  const runGroup = async (group: typeof entries): Promise<void> => {
    let previousTail: { readonly node: CanvasNodeId; readonly path: string } | undefined
    for (const [index, item] of group.entries()) {
      try {
        const startedEntry = await startEntry(item, previousTail)
        if (index === 0) noteFirstJob()
        const outcome = await startedEntry.recorded
        previousTail = outcome.tail ?? previousTail
      } catch (error: unknown) {
        const failure = retryableOf(error, new AbortController().signal)
        results.push({ node: item.node, ok: false, ...failure })
        /* v8 ignore next -- a later segment cannot fail before its group's first job was registered */
        if (index === 0) noteFirstJob()
      }
    }
  }
  const groupTasks = [...groups.values()].map(group => runGroup(group))
  const settle = Promise.all(groupTasks).then(() => results)
  if (groups.size > 0) await firstJobStarted
  return { status: 'started', plan, jobs, settle }
}

/**
 * Run one generation plan and wait for every job to settle.
 * @param services - canvas access, generators, jobs, and deployment bounds.
 * @param requested - node ids to generate.
 * @param token - budget token the caller confirmed, when it confirmed one.
 * @param options - `skipConfirmation` lets a caller that already confirmed a wider plan start this one.
 * @returns the refusal, the budget the caller must confirm, or what each node produced.
 */
export async function runPlan(
  services: RunnerServices,
  requested: readonly string[],
  token: string | undefined,
  options: { readonly skipConfirmation?: boolean } = {},
): Promise<RunOutcome> {
  const started = await startPlan(services, requested, token, options)
  if (started.status !== 'started') return started
  const results = await started.settle
  return { status: 'done', plan: started.plan, results }
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

/** Store the last frame of a finished video and point the video at the new frame version. */
async function recordTail(
  services: RunnerServices,
  video: CanvasNodeId,
  title: string,
  path: string,
  existing: { readonly node: CanvasNodeId; readonly version: NodeInput['version'] } | undefined,
): Promise<{ readonly node: CanvasNodeId; readonly path: string } | undefined> {
  const tailPath = await services.tailFrame(path)
  if (existing !== undefined) {
    await editLatest(services, [{
      op: 'append_version',
      node: existing.node,
      version: { path: tailPath, createdAt: services.now(), origin: 'agent' },
    }])
    const refreshed = (await services.canvas.read()).document.nodes
      .find(node => node.id === existing.node)?.activeVersion
    /* v8 ignore next -- the tail node was just written, so its active version exists */
    if (refreshed !== undefined) {
      await editLatest(services, [{ op: 'set_tail', node: video, tailOf: { node: existing.node, version: refreshed } }])
    }
    return { node: existing.node, path: tailPath }
  }
  const edit = await editLatest(services, [
    { op: 'add', ref: 'tail', type: 'image', title: `${title} · 尾帧`, path: tailPath },
  ])
  const tailId = edit.refs.tail
  /* v8 ignore next -- the add above always claims its ref */
  if (tailId === undefined) return undefined
  const tailVersion = (await services.canvas.read()).document.nodes.find(node => node.id === tailId)?.activeVersion
  const tailOps: CanvasOperation[] = [{ op: 'connect', from: video, to: tailId, kind: 'derivation' }]
  /* v8 ignore next -- the freshly added tail node always has a version */
  if (tailVersion !== undefined) tailOps.push({ op: 'set_tail', node: video, tailOf: { node: tailId, version: tailVersion } })
  await editLatest(services, tailOps)
  return { node: tailId, path: tailPath }
}
