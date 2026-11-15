/**
 * Executing one generation plan: apply the canvas edits the plan needs, run each node as a media
 * job, append the versions it produced, and keep the node status in step with the job.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  CanvasConflictError,
  type Bible,
  type CanvasDocument,
  type CanvasEditResult,
  type CanvasNode,
  type CanvasNodeId,
  type CanvasOperation,
  type NodeInput,
  type NodeStatus,
  type NodeVersion,
  type VersionId,
} from '@deepseek-ai/dsh-canvas'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import { collectInputs, planNodes, type NodePlan, type PlanLimits, type PlannedGeneration } from './node-runner.ts'
import type { MediaAttemptId, MediaCheckpoint, MediaJournal, RemoteMediaTask } from './journal.ts'
import { MediaGatewayError, MediaSubmissionRejectedError, MediaTaskFailedError } from './gateway.ts'

/** Admission and recovery coordination owned by one tool-media plugin instance. */
export interface MediaRunnerState {
  readonly liveAttempts: Set<string>
  readonly recovering: Map<string, Promise<readonly RecoveryJob[]>>
}

/** An existing paid attempt admitted for reconciliation, never a new submission. */
interface RecoveryJob {
  readonly node: CanvasNodeId
  readonly job: MediaJob
}

/**
 * Create admission and recovery coordination for one media owner.
 * @returns coordination shared by its Agent, Remote, and canvas-open entry points.
 */
export function createRunnerState(): MediaRunnerState {
  return { liveAttempts: new Set(), recovering: new Map() }
}

class SubmissionUnknownError extends Error {}

/** Local polling stopped with its owner; durable remote work may be resumed by the next owner. */
export class MediaInterruptedError extends Error {}

function startCheckpointJob(
  services: RunnerServices,
  checkpoint: MediaCheckpoint,
  spec: Parameters<RunnerServices['jobs']['start']>[0],
): MediaJob {
  try {
    const job = services.jobs.start(spec)
    services.state.liveAttempts.add(job.id)
    const release = (): void => {
      services.state.liveAttempts.delete(job.id)
    }
    void job.done.then(release, release)
    return job
  } catch (error: unknown) {
    services.state.liveAttempts.delete(checkpoint.id)
    throw error
  }
}

/** One media file a generator produced, with the numbers a version records. */
export interface GeneratedMedia {
  readonly path: string
  readonly model: string
  /** Effective generation settings and returned composition data, excluding encoded input files. */
  readonly params?: Readonly<Record<string, string | number | boolean>>
  readonly durationMs?: number
  readonly width?: number
  readonly height?: number
}

/** What one generation call needs, resolved from the canvas at run time. */
export interface MediaCall {
  /** Persist effective input values and submission intent before the paid request; supplied params replace the captured request. */
  readonly onSubmitting?: (input?: Pick<NodeVersion, 'prompt' | 'params'>) => Promise<void>
  /** Await a durable checkpoint immediately after a remote submission. */
  readonly onSubmitted?: (task: RemoteMediaTask) => Promise<void>
  /** Record the destination before the atomic artifact write. */
  readonly onArtifact?: (media: GeneratedMedia) => Promise<void>
  readonly node: CanvasNode
  readonly entry: PlannedGeneration
  /** Prompt with prompt edges and mentions already expanded. */
  readonly prompt: string
  /** Reference image files, in edge order. */
  readonly refs: readonly string[]
  /** Source or reference audio files resolved from the canvas, in edge order. */
  readonly audioReferences?: readonly string[]
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
  /** Poll an existing remote task and download its result without submitting again. */
  resume?(task: RemoteMediaTask, signal: AbortSignal, onArtifact?: MediaCall['onArtifact']): Promise<GeneratedMedia>
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
  readonly state: MediaRunnerState
  readonly journal?: MediaJournal
  readonly canvas: RunnerCanvas
  /** Project spec every generation follows. */
  readonly spec?: { readonly aspect?: string; readonly resolution?: string }
  readonly limits: PlanLimits
  /** Media jobs this call may run at once. */
  readonly concurrency: number
  readonly generate: MediaGenerator
  readonly jobs: {
    start(spec: { readonly label: string; readonly run: (signal: AbortSignal) => Promise<GeneratedMedia> }): MediaJob
    /** Ids of jobs still running, so a status left by a previous process is repaired. */
    live?(): readonly string[]
  }
  /** Probe a media file for duration and picture size. */
  readonly probe: (
    path: string,
  ) => Promise<{ readonly durationMs?: number; readonly width?: number; readonly height?: number }>
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
  | {
    readonly status: 'already_running'
    readonly nodes: readonly CanvasNodeId[]
    readonly jobs?: readonly { readonly node: CanvasNodeId; readonly jobId: JobId }[]
  }
  | {
    readonly status: 'started'
    readonly plan: NodePlan
    readonly jobs: readonly { readonly node: CanvasNodeId; readonly jobId: JobId }[]
    readonly settle: Promise<readonly NodeRunResult[]>
  }
  | { readonly status: 'done'; readonly plan: NodePlan; readonly results: readonly NodeRunResult[] }

/** Node the plan's reference created, when it created one. */
function nodeIdOf(entry: PlannedGeneration, refs: CanvasEditResult['refs']): CanvasNodeId {
  /* v8 ignore next -- a ref the plan named is always claimed by the same edit */
  return entry.ref === undefined ? entry.node : (refs[entry.ref] ?? entry.node)
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
    ...inputs.audio.map(one),
    ...(inputs.firstFrame === undefined ? [] : [one(inputs.firstFrame)]),
    ...(inputs.lastFrame === undefined ? [] : [one(inputs.lastFrame)]),
  ]
}

/**
 * Apply operations against the latest revision, retrying a lost race with a concurrent writer.
 * @param services - canvas access.
 * @param operations - edits to apply, in order.
 * @returns the edit result.
 */
async function editLatest(
  services: RunnerServices,
  operations: readonly CanvasOperation[] | ((document: CanvasDocument) => readonly CanvasOperation[]),
): Promise<CanvasEditResult> {
  for (let attempt = 0; ; attempt += 1) {
    const { document, revision } = await services.canvas.read()
    try {
      return await services.canvas.edit(typeof operations === 'function' ? operations(document) : operations, revision)
    } catch (error: unknown) {
      if (!(error instanceof CanvasConflictError) || attempt >= 4) throw error
    }
  }
}

/** Mark a node's status through the retrying editor. */
async function setStatus(
  services: RunnerServices,
  node: CanvasNodeId,
  status: Parameters<typeof statusOp>[0]['status'],
): Promise<void> {
  await editLatest(services, [statusOp({ node, status })])
}

/** Status operation for one node. */
function statusOp(change: { readonly node: CanvasNodeId; readonly status: NodeStatus | null }): CanvasOperation {
  return { op: 'set_status', node: change.node, status: change.status }
}

/**
 * Reconcile durable results and remote tasks, then fail orphaned statuses without resubmitting.
 * @param services - project-bound canvas, journal, jobs, and generators.
 * @returns existing attempts admitted for recovery, including ones that have already completed.
 */
export async function recoverInterrupted(services: RunnerServices): Promise<readonly RecoveryJob[]> {
  const recovered = await recoverMedia(services)
  const live = new Set(services.jobs.live?.() ?? [])
  const { document } = await services.canvas.read()
  for (const node of document.nodes) {
    const status = node.status
    if (status === undefined || status.state === 'failed') continue
    if (live.has(status.jobId) || services.state.liveAttempts.has(status.jobId)) continue
    await setStatus(services, node.id, {
      state: 'failed',
      at: services.now(),
      error: 'interrupted by a restart',
      retryable: true,
    })
  }
  return recovered
}

function ownsCheckpoint(node: CanvasNode, checkpoint: MediaCheckpoint): boolean {
  const status = node.status
  if (status?.jobId !== undefined) return status.jobId === checkpoint.jobId || status.jobId === String(checkpoint.id)
  return (
    node.activeVersion === checkpoint.baseVersion ||
    node.activeVersion === `media-${checkpoint.id}` ||
    node.versions?.some(version => version.id === `media-${checkpoint.id}`) === true
  )
}

async function markCheckpointRunning(
  services: RunnerServices,
  checkpoint: MediaCheckpoint,
  jobId: JobId,
): Promise<void> {
  await editLatest(services, (document) => {
    const node = document.nodes.find(candidate => candidate.id === checkpoint.node)
    if (node === undefined || !ownsCheckpoint(node, checkpoint)) throw new Error('a newer task owns this node')
    return [{ op: 'set_status', node: node.id, status: { state: 'running', jobId, at: services.now() } }]
  })
}

/** Recompute ownership and version identity on every CAS retry. */
async function attachCheckpoint(
  services: RunnerServices,
  checkpoint: MediaCheckpoint,
  media: GeneratedMedia,
): Promise<void> {
  const id = brandString<VersionId>(`media-${checkpoint.id}`)
  await editLatest(services, (document) => {
    const node = document.nodes.find(candidate => candidate.id === checkpoint.node)
    if (node === undefined || !ownsCheckpoint(node, checkpoint))
      throw new Error('media result retained: node was deleted or a newer task owns it')
    const existing = node.versions?.some(version => version.id === id) === true
    return [
      ...(existing
        ? []
        : [
          {
            op: 'append_version' as const,
            node: node.id,
            version: {
              ...checkpoint.versionBody,
              ...media,
              ...(media.params === undefined
                ? {}
                : { params: { ...checkpoint.versionBody.params, ...media.params } }),
              id,
            },
          },
        ]),
    ]
  })
}

async function finishCheckpoint(services: RunnerServices, checkpoint: MediaCheckpoint): Promise<void> {
  await editLatest(services, (document) => {
    const node = document.nodes.find(candidate => candidate.id === checkpoint.node)
    return node === undefined || !ownsCheckpoint(node, checkpoint)
      ? []
      : [{ op: 'set_status', node: node.id, status: null }]
  })
}

async function failCheckpoint(
  services: RunnerServices,
  checkpoint: MediaCheckpoint,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  const failure = retryableOf(error, signal)
  await editLatest(services, (document) => {
    const node = document.nodes.find(candidate => candidate.id === checkpoint.node)
    return node === undefined || !ownsCheckpoint(node, checkpoint)
      ? []
      : [
        {
          op: 'set_status',
          node: checkpoint.node,
          status: {
            state: 'failed',
            at: services.now(),
            ...failure,
            ...(checkpoint.jobId === undefined ? {} : { jobId: checkpoint.jobId }),
          },
        },
      ]
  })
}

/** Recover saved files first; otherwise resume a known remote id. Never resubmit a paid request. */
async function recoverMedia(services: RunnerServices): Promise<readonly RecoveryJob[]> {
  const journal = services.journal
  if (journal === undefined) return []
  const previous = services.state.recovering.get(journal.scope)
  if (previous !== undefined) return previous
  const reconcile = async (): Promise<readonly RecoveryJob[]> => {
    const recovered: RecoveryJob[] = []
    for (const saved of await journal.read()) {
      if (services.state.liveAttempts.has(saved.id)) continue
      if (saved.jobId !== undefined && services.jobs.live?.().includes(saved.jobId) === true) continue
      const node = (await services.canvas.read()).document.nodes.find(candidate => candidate.id === saved.node)
      if (node === undefined || !ownsCheckpoint(node, saved)) continue
      if (saved.state === 'failed' || saved.state === 'cancelled') {
        if (node.status?.state === 'running' || node.status?.state === 'queued') {
          const error = Object.assign(new Error(saved.error ?? 'interrupted'), {
            retryable: saved.retryable ?? true,
            recoveryRequired: saved.recoveryRequired ?? false,
          })
          await failCheckpoint(services, saved, error, new AbortController().signal)
        }
        continue
      }
      let fileExists = false
      if (saved.media !== undefined) {
        try {
          fileExists = (await stat(saved.media.path)).isFile()
        } catch (error: unknown) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
      if (!fileExists && (saved.remote === undefined || services.generate.resume === undefined)) {
        const beforeSubmission = saved.state === 'queued' || saved.submissionStarted === false
        const message = beforeSubmission
          ? 'interrupted before submission; retry explicitly'
          : 'interrupted; remote submission outcome is unknown; verify provider history before retrying'
        const error = beforeSubmission ? new Error(message) : new SubmissionUnknownError(message)
        await failCheckpoint(services, saved, error, new AbortController().signal)
        await journal.write({ ...saved, state: 'failed', ...retryableOf(error, new AbortController().signal) })
        continue
      }
      services.state.liveAttempts.add(saved.id)
      let checkpoint = saved
      const admission = Promise.withResolvers<void>()
      const job = startCheckpointJob(services, saved, {
        label: `Recover ${node.title}`,
        run: async (signal) => {
          try {
            await admission.promise
            let media: GeneratedMedia
            const remote = saved.remote
            if (fileExists && saved.media !== undefined) media = saved.media
            else if (remote !== undefined && services.generate.resume !== undefined) {
              media = await services.generate.resume(remote, signal, async (artifact) => {
                checkpoint = { ...checkpoint, media: artifact }
                await journal.write(checkpoint)
              })
            } else throw new SubmissionUnknownError('remote task cannot be resumed; no new request was submitted')
            signal.throwIfAborted()
            checkpoint = { ...checkpoint, state: 'produced', media }
            await journal.write(checkpoint)
            const probe = node.type === 'video' ? await services.probe(media.path) : {}
            await attachCheckpoint(services, checkpoint, { ...media, ...probe })
            if (node.type === 'video')
              await recordTail(
                services,
                node.id,
                node.title,
                media.path,
                brandString<VersionId>(`media-${checkpoint.id}`),
                node.tailOf,
              )
            await finishCheckpoint(services, checkpoint)
            await journal.remove(saved.id)
            return media
          } catch (error: unknown) {
            const failure = attemptFailure(checkpoint, error, signal)
            checkpoint = {
              ...checkpoint,
              state: stateAfterFailure(checkpoint, error, signal),
              ...failure,
            }
            await journal.write(checkpoint)
            const reported = Object.assign(new Error(failure.error, { cause: error }), failure)
            await failCheckpoint(services, checkpoint, reported, signal)
            throw reported
          } finally {
            services.state.liveAttempts.delete(saved.id)
          }
        },
      })
      // Recovery does not block opening a canvas while a remote task is still running.
      void job.done.catch((_error: unknown) => undefined) // The job registry and failed node expose the failure.
      checkpoint = { ...checkpoint, state: fileExists ? 'produced' : 'running', jobId: job.id }
      try {
        await journal.write(checkpoint)
        await markCheckpointRunning(services, saved, job.id)
        admission.resolve()
        recovered.push({ node: saved.node, job })
      } catch (error: unknown) {
        admission.reject(error)
        throw error
      }
    }
    return recovered
  }
  const recovery = (async () => {
    // Do not create a .canvas directory just to lock an empty or missing journal.
    if ((await journal.read()).length === 0) return []
    return journal.withRecoveryLock === undefined ? reconcile() : journal.withRecoveryLock(reconcile)
  })()
  services.state.recovering.set(journal.scope, recovery)
  try {
    return await recovery
  } finally {
    services.state.recovering.delete(journal.scope)
  }
}

/** Retryability of one generation failure. */
function retryableOf(
  error: unknown,
  signal: AbortSignal,
): {
  readonly error: string
  readonly retryable: boolean
  readonly recoveryRequired?: boolean
} {
  const message = error instanceof Error ? error.message : String(error)
  if (
    error instanceof SubmissionUnknownError ||
    (error !== null && typeof error === 'object' && 'recoveryRequired' in error && error.recoveryRequired === true)
  ) {
    return { error: message, retryable: false, recoveryRequired: true }
  }
  if (signal.aborted) return { error: 'cancelled', retryable: true }
  if (error !== null && typeof error === 'object' && 'retryable' in error && typeof error.retryable === 'boolean') {
    return { error: message, retryable: error.retryable }
  }
  const status = error !== null && typeof error === 'object' && 'status' in error ? error.status : undefined
  if (typeof status === 'number' && status >= 400 && status < 500) return { error: message, retryable: false }
  return { error: message, retryable: true }
}

function attemptFailure(
  checkpoint: MediaCheckpoint,
  error: unknown,
  signal: AbortSignal,
): ReturnType<typeof retryableOf> {
  if (signal.aborted && signal.reason instanceof MediaInterruptedError) {
    if (checkpoint.remote !== undefined || checkpoint.media !== undefined) {
      return {
        error:
          'Generation interrupted locally; reopen the canvas to reconcile the existing task or file before retrying',
        retryable: false,
        recoveryRequired: true,
      }
    }
    if (checkpoint.submissionStarted === false)
      return { error: 'Generation interrupted before submission; retry explicitly', retryable: true }
    return retryableOf(
      new SubmissionUnknownError('Generation interrupted; verify the remote submission outcome before retrying'),
      signal,
    )
  }
  if (checkpoint.state === 'produced' && checkpoint.media !== undefined && !signal.aborted) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      error: `Media is ready but canvas finalization failed. Reopen the canvas to finish recovery: ${message}`,
      retryable: false,
      recoveryRequired: true,
    }
  }
  const rejected =
    error instanceof MediaSubmissionRejectedError ||
    (error instanceof MediaGatewayError && error.status !== undefined && error.status >= 400 && error.status < 500)
  const uncertain =
    checkpoint.submissionStarted !== false &&
    checkpoint.state === 'running' &&
    checkpoint.remote === undefined &&
    !rejected
  const remoteCancelledLocally =
    signal.aborted && checkpoint.submissionStarted !== false && checkpoint.media === undefined
  return retryableOf(
    uncertain || remoteCancelledLocally
      ? new SubmissionUnknownError(
        signal.aborted
          ? 'Cancelled locally; the remote generation may still be running. Verify provider history before retrying'
          : `Remote submission outcome is unknown (${error instanceof Error ? error.message : String(error)}); verify provider history before starting another generation`,
      )
      : error,
    signal,
  )
}

/** An intended artifact path is not proof that its complete file was published. */
function stateAfterFailure(checkpoint: MediaCheckpoint, error: unknown, signal: AbortSignal): MediaCheckpoint['state'] {
  if (signal.aborted && signal.reason instanceof MediaInterruptedError) {
    if (checkpoint.state === 'produced') return 'produced'
    if (checkpoint.remote !== undefined || checkpoint.media !== undefined) return 'running'
    return checkpoint.submissionStarted === false ? 'queued' : 'failed'
  }
  if (signal.aborted) return 'cancelled'
  if (checkpoint.state === 'produced') return 'produced'
  if (error instanceof MediaTaskFailedError) return 'failed'
  if (checkpoint.remote !== undefined || checkpoint.media !== undefined) return 'running'
  return 'failed'
}

/**
 * Start one generation plan, returning as soon as every job is registered.
 * @param services - canvas access, generators, jobs, and deployment bounds.
 * @param requested - node ids to generate.
 * @returns the refusal or the started jobs and their settlement.
 */
export async function startPlan(
  services: RunnerServices,
  requested: readonly string[],
): Promise<Exclude<RunOutcome, { readonly status: 'done' }>> {
  const recovered = await recoverInterrupted(services)
  const loaded = await services.canvas.read()
  const bible = await services.canvas.bible()
  const proposed = planNodes(loaded.document, bible, requested, services.limits)
  const selectedRecovery = recovered.filter(
    item => requested.includes(item.node) || proposed.entries.some(entry => entry.node === item.node),
  )
  const recoveredNodes = new Set<string>(selectedRecovery.map(item => item.node))
  const plan: NodePlan = {
    ...proposed,
    nodes: proposed.nodes.filter(node => !recoveredNodes.has(node.node)),
    entries: proposed.entries.filter(entry => !recoveredNodes.has(entry.node)),
    ...(proposed.edits === undefined
      ? {}
      : {
        edits: proposed.edits.filter(edit => !('node' in edit && recoveredNodes.has(edit.node))),
      }),
  }
  if (plan.blocked !== undefined) return { status: 'blocked', plan }
  // Replan the remaining batch after recovery so its budget and tail inputs use recovered versions.
  if (selectedRecovery.length > 0 && plan.entries.length > 0) {
    return {
      status: 'already_running',
      nodes: selectedRecovery.map(item => item.node),
      jobs: selectedRecovery.map(item => ({ node: item.node, jobId: item.job.id })),
    }
  }
  const running = plan.entries
    .map(entry => entry.node)
    .filter((node) => {
      const status = loaded.document.nodes.find(candidate => candidate.id === node)?.status
      return status?.state === 'running' || status?.state === 'queued'
    })
  if (running.length > 0) return { status: 'already_running', nodes: running }

  const edits: CanvasOperation[] = [
    ...plan.create,
    ...(plan.edits ?? []),
    ...plan.stale.map(node => ({ op: 'set_stale' as const, node, stale: true })),
  ]
  const refs = edits.length === 0 ? {} : (await editLatest(services, edits)).refs
  const entries = plan.entries.map(entry => ({ entry, node: nodeIdOf(entry, refs) }))
  const groups = new Map<string, typeof entries>()
  for (const item of entries) {
    const key =
      item.entry.storyboard === undefined ? `node:${String(item.node)}` : `board:${String(item.entry.storyboard)}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }

  const jobs = selectedRecovery.map(item => ({ node: item.node, jobId: item.job.id }))
  const results: NodeRunResult[] = []
  const recoveredTasks = selectedRecovery.map(async ({ node, job }) => {
    try {
      const media = await job.done
      results.push({ node, ok: true, jobId: job.id, path: media.path })
    } catch (error: unknown) {
      results.push({ node, ok: false, jobId: job.id, ...retryableOf(error, job.signal) })
    }
  })
  let active = 0
  const waiting: (() => void)[] = []
  /** Wait for a free slot under the deployment's concurrency bound. */
  const acquire = async (): Promise<void> => {
    while (active >= Math.max(1, services.concurrency)) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve)
      })
    }
    active += 1
  }
  const release = (): void => {
    active -= 1
    waiting.shift()?.()
  }

  /** Prepare one entry, start its job, and start recording what it produces. */
  const startEntry = async (
    item: (typeof entries)[number],
    previousTail: NodeInput | undefined,
  ): Promise<{
    readonly jobId: JobId
    readonly done: Promise<GeneratedMedia>
    readonly recorded: Promise<{ readonly tail?: NodeInput; readonly failed?: boolean }>
  }> => {
    const { entry, node } = item
    const document = (await services.canvas.read()).document
    const current = document.nodes.find(candidate => candidate.id === node)
    /* v8 ignore next -- the plan created or found this node in the same run */
    if (current === undefined) throw new Error(`node ${String(node)} disappeared before it could generate`)
    const plannedTail =
      entry.tailChain === undefined
        ? undefined
        : document.nodes
          .find(candidate => candidate.id === entry.tailChain?.node)
          ?.versions?.find(version => version.id === entry.tailChain?.version)
    const chainedTail =
      entry.chain !== true
        ? undefined
        : (previousTail ??
          (entry.tailChain === undefined || plannedTail?.path === undefined
            ? undefined
            : { node: entry.tailChain.node, version: entry.tailChain.version, path: plannedTail.path }))
    const inputs = collectInputs(
      document,
      current,
      bible,
      chainedTail === undefined ? undefined : { ...chainedTail, role: 'first_frame' },
    )
    const firstFramePath = chainedTail?.path ?? inputs.firstFrame?.path
    if (
      chainedTail !== undefined &&
      !document.edges.some(
        edge =>
          edge.source === chainedTail.node &&
          edge.target === node &&
          edge.kind === 'reference' &&
          edge.role === 'first_frame',
      )
    ) {
      await editLatest(services, [
        { op: 'connect', from: chainedTail.node, to: node, kind: 'reference', role: 'first_frame' },
      ])
    }
    const missingRefs = inputs.refs.filter(
      ref => !document.edges.some(edge => edge.source === ref.node && edge.target === node && edge.role === 'ref'),
    )
    /* v8 ignore next -- every reference the plan found is not connected yet on a first run */
    if (missingRefs.length > 0) {
      await editLatest(
        services,
        missingRefs.map((ref, order) => ({
          op: 'connect' as const,
          from: ref.node,
          to: node,
          kind: 'reference' as const,
          role: 'ref' as const,
          order,
        })),
      )
    }
    let checkpoint: MediaCheckpoint = {
      version: 1,
      id: brandString<MediaAttemptId>(randomUUID()),
      node,
      state: 'queued',
      submissionStarted: false,
      ...(current.activeVersion === undefined ? {} : { baseVersion: current.activeVersion }),
      versionBody: {
        createdAt: services.now(),
        origin: 'agent',
        prompt: inputs.prompt,
        model: entry.model,
        params: { ...current.gen?.params, ...(entry.seconds === undefined ? {} : { duration: entry.seconds }) },
        inputs: inputsOf(chainedTail === undefined ? inputs : { ...inputs, refs: [] }),
      },
    }
    services.state.liveAttempts.add(checkpoint.id)
    const admission = Promise.withResolvers<void>()
    let completedTail: NodeInput | undefined
    const job = startCheckpointJob(services, checkpoint, {
      label: current.title,
      run: async (signal) => {
        let acquired = false
        try {
          await admission.promise
          await acquire()
          acquired = true
          signal.throwIfAborted()
          checkpoint = { ...checkpoint, state: 'running' }
          await services.journal?.write(checkpoint)
          await markCheckpointRunning(services, checkpoint, job.id)
          const media = await generate(
            services,
            current,
            entry,
            {
              prompt: inputs.prompt,
              refs: chainedTail === undefined ? inputs.refs.map(ref => ref.path) : [],
              audioReferences: inputs.audio.map(ref => ref.path),
              ...(firstFramePath === undefined ? {} : { firstFramePath }),
              ...(inputs.lastFrame === undefined ? {} : { lastFramePath: inputs.lastFrame.path }),
              onSubmitting: async (input) => {
                const submitting = {
                  ...checkpoint,
                  submissionStarted: true,
                  versionBody: { ...checkpoint.versionBody, ...input },
                }
                await services.journal?.write(submitting)
                checkpoint = submitting
              },
              onSubmitted: async (remote) => {
                checkpoint = { ...checkpoint, remote }
                await services.journal?.write(checkpoint)
              },
              onArtifact: async (artifact) => {
                checkpoint = { ...checkpoint, media: artifact }
                await services.journal?.write(checkpoint)
              },
            },
            signal,
          )
          signal.throwIfAborted()
          checkpoint = { ...checkpoint, state: 'produced', media }
          await services.journal?.write(checkpoint)
          const probe =
            media.durationMs === undefined && current.type === 'video' ? await services.probe(media.path) : {}
          await attachCheckpoint(services, checkpoint, { ...media, ...probe })
          if (current.type === 'video') {
            completedTail = await recordTail(
              services,
              node,
              current.title,
              media.path,
              brandString<VersionId>(`media-${checkpoint.id}`),
              current.tailOf,
            )
          }
          await finishCheckpoint(services, checkpoint)
          await services.journal?.remove(checkpoint.id)
          return media
        } catch (error: unknown) {
          const failure = attemptFailure(checkpoint, error, signal)
          checkpoint = {
            ...checkpoint,
            state: stateAfterFailure(checkpoint, error, signal),
            error: failure.error,
            retryable: failure.retryable,
            ...(failure.recoveryRequired === undefined ? {} : { recoveryRequired: failure.recoveryRequired }),
          }
          try {
            await services.journal?.write(checkpoint)
          } finally {
            await failCheckpoint(services, checkpoint, Object.assign(new Error(failure.error), failure), signal)
          }
          throw Object.assign(new Error(failure.error, { cause: error }), failure)
        } finally {
          if (acquired) release()
          services.state.liveAttempts.delete(checkpoint.id)
        }
      },
    })
    checkpoint = { ...checkpoint, jobId: job.id }
    jobs.push({ node, jobId: job.id })
    const recorded = job.done.then(
      (media) => {
        results.push({ node, ok: true, jobId: job.id, path: media.path })
        return completedTail === undefined ? {} : { tail: completedTail }
      },
      (error: unknown) => {
        const failure = retryableOf(error, job.signal)
        results.push({ node, ok: false, jobId: job.id, ...failure })
        return { failed: true }
      },
    )
    try {
      await services.journal?.write(checkpoint)
      await editLatest(services, (latest) => {
        const held = latest.nodes.find(candidate => candidate.id === node)?.status
        if (held?.state === 'queued' || held?.state === 'running')
          throw new Error(`node ${node} already has a running task`)
        return [{ op: 'set_status', node, status: { state: 'queued', jobId: job.id, at: services.now() } }]
      })
      admission.resolve()
    } catch (error: unknown) {
      admission.reject(error)
    }
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
    let previousTail: NodeInput | undefined
    for (const [index, item] of group.entries()) {
      try {
        const startedEntry = await startEntry(item, previousTail)
        if (index === 0) noteFirstJob()
        const outcome = await startedEntry.recorded
        previousTail = outcome.tail ?? previousTail
        if (outcome.failed === true) break
      } catch (error: unknown) {
        const failure = retryableOf(error, new AbortController().signal)
        await editLatest(services, (document) => {
          const node = document.nodes.find(candidate => candidate.id === item.node)
          return node === undefined || node.status?.state === 'running' || node.status?.state === 'queued'
            ? []
            : [{ op: 'set_status', node: item.node, status: { state: 'failed', at: services.now(), ...failure } }]
        })
        results.push({ node: item.node, ok: false, ...failure })
        /* v8 ignore next -- a later segment cannot fail before its group's first job was registered */
        if (index === 0) noteFirstJob()
      }
    }
  }
  const groupTasks = [...groups.values()].map(group => runGroup(group))
  const settle = Promise.all([...groupTasks, ...recoveredTasks]).then(() => results)
  if (groups.size > 0) await firstJobStarted
  return { status: 'started', plan, jobs, settle }
}

/**
 * Run one generation plan and wait for every job to settle.
 * @param services - canvas access, generators, jobs, and deployment bounds.
 * @param requested - node ids to generate.
 * @returns the refusal or what each node produced.
 */
export async function runPlan(
  services: RunnerServices,
  requested: readonly string[],
): Promise<RunOutcome> {
  const started = await startPlan(services, requested)
  if (started.status !== 'started') return started
  const results = await started.settle
  return { status: 'done', plan: started.plan, results }
}

/** Call the generator that matches one node. */
async function generate(
  services: RunnerServices,
  node: CanvasNode,
  entry: PlannedGeneration,
  resolved: Pick<
    MediaCall,
    | 'prompt'
    | 'refs'
    | 'audioReferences'
    | 'firstFramePath'
    | 'lastFramePath'
    | 'onSubmitting'
    | 'onSubmitted'
    | 'onArtifact'
  >,
  signal: AbortSignal,
): Promise<GeneratedMedia> {
  const call: MediaCall = {
    node,
    entry,
    signal,
    ...resolved,
    ...(services.spec?.aspect === undefined ? {} : { aspectRatio: services.spec.aspect }),
    ...(services.spec?.resolution === undefined ? {} : { resolution: services.spec.resolution }),
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
  sourceVersion: VersionId,
  existing: { readonly node: CanvasNodeId; readonly version: NodeInput['version'] } | undefined,
): Promise<NodeInput | undefined> {
  const document = (await services.canvas.read()).document
  const frame =
    document.nodes.find(candidate => candidate.id === existing?.node) ??
    document.nodes.find(
      candidate =>
        candidate.type === 'image' &&
        candidate.versions?.some(
          version =>
            version.inputs?.some(input => input.node === video && input.version === sourceVersion) === true,
        ) === true &&
        document.edges.some(
          edge => edge.kind === 'derivation' && edge.source === video && edge.target === candidate.id,
        ),
    )
  const captured = frame?.versions?.find(
    version =>
      version.path !== undefined &&
      version.inputs?.some(input => input.node === video && input.version === sourceVersion) === true,
  )
  const tailPath = captured?.path ?? (await services.tailFrame(path))
  const inputs: readonly NodeInput[] = [{ node: video, version: sourceVersion, path, role: 'source' }]
  const record = async (node: CanvasNodeId, version: VersionId): Promise<NodeInput> => {
    await editLatest(services, (document) => {
      const source = document.nodes.find(node => node.id === video)
      return source === undefined || (source.activeVersion !== undefined && source.activeVersion !== sourceVersion)
        ? []
        : [{ op: 'set_tail', node: video, tailOf: { node, version, sourceVersion } }]
    })
    return { node, version, path: tailPath, role: 'first_frame' }
  }
  if (frame !== undefined) {
    const matching = frame.versions?.find(
      version =>
        version.path === tailPath &&
        version.inputs?.some(input => input.node === video && input.version === sourceVersion) === true,
    )
    const version = matching?.id ?? brandString<VersionId>(`${sourceVersion}-tail`)
    if (matching === undefined)
      await editLatest(services, [
        {
          op: 'append_version',
          node: frame.id,
          version: { id: version, path: tailPath, createdAt: services.now(), origin: 'agent', inputs },
        },
      ])
    return record(frame.id, version)
  }
  const edit = await editLatest(services, [
    { op: 'add', ref: 'tail', type: 'image', title: `${title} · 尾帧`, path: tailPath, candidate: true, inputs },
    { op: 'connect', from: video, to: 'tail', kind: 'derivation' },
  ])
  const tailId = edit.refs.tail
  /* v8 ignore next -- the add above always claims its ref */
  if (tailId === undefined) return undefined
  const tailVersion = (await services.canvas.read()).document.nodes.find(node => node.id === tailId)?.versions?.[0]
    ?.id
  if (tailVersion === undefined) throw new Error('Tail-frame version was not recorded')
  return record(tailId, tailVersion)
}
