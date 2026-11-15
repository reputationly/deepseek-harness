/** Host-owned render jobs, upload leases, and immutable full-quality caches. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CanvasService } from '@deepseek-ai/dsh-canvas'
import type { CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { JobId, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FfmpegRunner } from './ffmpeg.ts'
import {
  resolveTimelinePlan,
  timelineInputsUnchanged,
  timelineSegmentSamples,
  type TimelineRenderConfig,
} from './timeline-plan.ts'
import type {
  TimelineCacheKey,
  TimelineRenderLease,
  TimelineRenderPart,
  TimelineRenderPlan,
  TimelineRenderView,
  TimelineRenderWork,
  TimelineRenderErrorCode,
  TimelineRenderState,
  TimelineRenderNotice,
  TimelineExportResult,
  TimelineRenderAsset,
} from './timeline-render-types.ts'

/**
 * A classified render failure carried through the media Remote boundary.
 */
export class TimelineRenderError extends Error {
  constructor(
    readonly code: TimelineRenderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TimelineRenderError'
  }
}

interface RenderRecord {
  readonly version: 1
  readonly key: TimelineCacheKey
  readonly contentKey: TimelineCacheKey
  readonly revision: number
  readonly state: TimelineRenderState
  readonly progress: number
  readonly error?: TimelineRenderView['error']
  readonly output?: Receipt
}
interface Receipt {
  readonly size: number
  readonly modifiedMs: number
  readonly hash: string
}
interface SegmentReceipt {
  readonly version: 1
  readonly video: Receipt
  readonly audio: Receipt
}
interface Upload {
  readonly file: FileHandle
  readonly temporary: string
  readonly target: string
  readonly hash: ReturnType<typeof createHash>
  size: number
}
interface RenderEntry {
  readonly owner: Session
  readonly directory: string
  readonly root: string
  readonly basePlan: TimelineRenderPlan
  plan: TimelineRenderPlan
  readonly jobId: JobId
  readonly done: (outcome: JobOutcome) => void
  readonly uploads: Map<string, Upload>
  readonly receipts: Map<string, Receipt>
  readonly pending: Set<Promise<unknown>>
  abort: AbortController
  record: RenderRecord
  lease: TimelineRenderLease | undefined
  touched: number
}

/** Producer dependencies; remote generation and its credentials are deliberately absent. */
export interface TimelineRendererDeps {
  readonly canvas: () => CanvasService
  readonly jobs: Pick<JobRegistry, 'start'> | undefined
  readonly ffmpeg: Pick<FfmpegRunner, 'probe'>
  readonly config: TimelineRenderConfig
  readonly notify: (notice: TimelineRenderNotice) => void
  readonly report: (error: unknown) => void
  readonly compatible: (
    asset: TimelineRenderAsset,
    directory: string,
    signal: AbortSignal,
  ) => Promise<TimelineRenderAsset>
}

const terminal = (state: TimelineRenderState): boolean =>
  ['ready', 'cancelled', 'interrupted', 'failed'].includes(state)
function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
function recordOf(value: unknown): RenderRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('key' in value) ||
    typeof value.key !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.key) ||
    !('contentKey' in value) ||
    typeof value.contentKey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.contentKey) ||
    !('revision' in value) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !('state' in value) ||
    !['stale', 'queued', 'rendering', 'assembling', 'ready', 'cancelled', 'interrupted', 'failed'].includes(
      String(value.state),
    ) ||
    !('progress' in value) ||
    typeof value.progress !== 'number' ||
    !Number.isFinite(value.progress) ||
    value.progress < 0 ||
    value.progress > 1
  ) {
    throw new TimelineRenderError(
      'storage',
      'timeline cache metadata is damaged; clear this timeline cache and render again',
    )
  }
  if ('error' in value && value.error !== undefined) {
    const error = value.error
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      !('message' in error) ||
      !['source', 'encoding', 'upload', 'lease', 'probe', 'storage', 'renderer'].includes(String(error.code)) ||
      typeof error.message !== 'string'
    ) {
      throw new TimelineRenderError(
        'storage',
        'timeline cache error metadata is damaged; clear this timeline cache and render again',
      )
    }
  }
  return value as RenderRecord
}

/** One Host writes every render artifact; a lease never authorizes a caller-supplied path. */
export class TimelineRenderer {
  private readonly entries = new Map<JobId, RenderEntry>()
  private readonly byRoot = new Map<string, RenderEntry>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly requests = new Set<Promise<unknown>>()
  private readonly shutdown = new AbortController()
  private disposed = false
  constructor(private readonly deps: TimelineRendererDeps) {}

  private accepted<T>(run: () => Promise<T>): Promise<T> {
    if (this.isDisposed()) return Promise.reject(new TimelineRenderError('renderer', 'timeline renderer is shutting down'))
    const pending = run()
    this.requests.add(pending)
    const finished = (): void => {
      this.requests.delete(pending)
    }
    void pending.then(finished, finished)
    return pending
  }

  private async serialized<T>(root: string, run: () => Promise<T>): Promise<T> {
    const current = (this.queues.get(root) ?? Promise.resolve()).then(run)
    const tail = current.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(root, tail)
    try {
      return await current
    } finally {
      if (this.queues.get(root) === tail) this.queues.delete(root)
    }
  }
  private async location(
    session: Session,
    node: CanvasNodeId,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<string> {
    if (!/^n[1-9][0-9]*$/.test(node)) throw new TimelineRenderError('source', 'invalid timeline node id')
    const target = await this.deps.canvas().targetOf(session, episode, expectedDirectory)
    return join(target.directory, '.canvas', `${target.file}.render`, node)
  }
  private async readRecord(root: string): Promise<RenderRecord | undefined> {
    let text: string
    try {
      text = await readFile(join(root, 'state.json'), 'utf8')
    } catch (error: unknown) {
      if (missing(error)) return undefined
      throw error
    }
    try {
      const value: unknown = JSON.parse(text)
      return recordOf(value)
    } catch (error: unknown) {
      if (error instanceof TimelineRenderError) throw error
      throw new TimelineRenderError(
        'storage',
        'timeline cache metadata is damaged; clear this timeline cache and render again',
        { cause: error },
      )
    }
  }
  private async save(entry: RenderEntry): Promise<void> {
    await writeFileAtomic(join(entry.root, 'state.json'), JSON.stringify(entry.record), { mode: 0o600, dirMode: 0o700 })
    this.deps.notify({
      sessionId: entry.owner.id,
      directory: entry.directory,
      node: entry.plan.node,
      episode: entry.plan.episode,
      jobId: entry.jobId,
      state: entry.record.state,
      revision: entry.plan.document.revision,
    })
  }
  private async viewOf(root: string, plan: TimelineRenderPlan): Promise<TimelineRenderView> {
    const entry = this.byRoot.get(root),
      record = entry?.record ?? (await this.readRecord(root))
    if (record === undefined || record.contentKey !== plan.key || !(await timelineInputsUnchanged(plan))) {
      return { revision: plan.document.revision, state: 'stale', progress: 0 }
    }
    const state =
      entry === undefined && ['queued', 'rendering', 'assembling'].includes(record.state) ? 'interrupted' : record.state
    const path = join(root, `${record.key}.mp4`)
    if (state === 'ready' && !(await this.matches(path, record.output))) {
      return { revision: plan.document.revision, state: 'stale', progress: 0 }
    }
    return {
      revision: plan.document.revision,
      state,
      progress: record.progress,
      ...(entry === undefined ? {} : { jobId: entry.jobId }),
      ...(state !== 'ready' ? {} : { path }),
      ...(record.error === undefined ? {} : { error: record.error }),
    }
  }

  /**
   * Read the current timeline revision and verify its cached full-quality output.
   * @returns the current revision's cache or job; a stale file is never exposed as its preview.
   * @param session - Session that owns the project and render task.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param episode - Explicit episode; omission uses the Session binding.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   */
  async status(
    session: Session,
    node: CanvasNodeId,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<TimelineRenderView> {
    const canvas = this.deps.canvas(),
      scope = await canvas.targetOf(session, episode, expectedDirectory)
    const document = await canvas.timeline(session, node, scope.episode.id, scope.directory)
    if (document === undefined || !document.tracks.some(track => track.clips.length !== 0))
      return { revision: document?.revision ?? 0, state: 'stale', progress: 0 }
    const target = await resolveTimelinePlan(
      canvas,
      session,
      node,
      document.revision,
      this.deps.config,
      scope.episode.id,
      scope.directory,
    )
    const root = await this.location(session, node, target.plan.episode, target.directory)
    return this.serialized(root, () => this.viewOf(root, target.plan))
  }

  /**
   * Enqueue or reuse this exact revision. Repeating a start does not create another live job.
   * @param session - Session that owns the project and render task.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param revision - Reviewed timeline revision that must still be current.
   * @param episode - Explicit episode; omission uses the Session binding.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   * @param completionNotice - UI callers suppress model notices; model tools retain normal job completion delivery.
   * @returns The existing or newly queued render state.
   */
  start(
    session: Session,
    node: CanvasNodeId,
    revision: number,
    episode?: EpisodeId,
    expectedDirectory?: string,
    completionNotice?: 'none',
  ): Promise<TimelineRenderView> {
    return this.accepted(() =>
      this.startAccepted(session, node, revision, episode, expectedDirectory, completionNotice),
    )
  }
  private async startAccepted(
    session: Session,
    node: CanvasNodeId,
    revision: number,
    episode?: EpisodeId,
    expectedDirectory?: string,
    completionNotice?: 'none',
  ): Promise<TimelineRenderView> {
    const target = await resolveTimelinePlan(
      this.deps.canvas(),
      session,
      node,
      revision,
      this.deps.config,
      episode,
      expectedDirectory,
    )
    const root = await this.location(session, node, target.plan.episode, target.directory)
    const previous = this.byRoot.get(root)
    if (previous !== undefined && !terminal(previous.record.state) && previous.basePlan.key !== target.plan.key) {
      previous.abort.abort()
    }
    return this.serialized(root, async () => {
      if (this.isDisposed()) throw new TimelineRenderError('renderer', 'timeline renderer is shutting down')
      // A different start may have entered the queue after the first plan read.
      const current = await this.deps.canvas().timeline(session, node, target.plan.episode, target.directory)
      if (current?.revision !== revision || !(await timelineInputsUnchanged(target.plan))) {
        throw new TimelineRenderError(
          'source',
          'timeline or source changed before rendering; read the current revision',
        )
      }
      const held = this.byRoot.get(root)
      if (held !== undefined && !terminal(held.record.state) && held.basePlan.key !== target.plan.key) {
        held.abort.abort()
        await this.stopLocked(held, 'interrupted', 'a newer timeline revision replaced this render')
      }
      const status = await this.viewOf(root, target.plan)
      const live = this.byRoot.get(root)
      if (status.state === 'ready' || (live?.basePlan.key === target.plan.key && !terminal(live.record.state)))
        return status
      const jobs = this.deps.jobs
      if (jobs === undefined) throw new TimelineRenderError('renderer', 'timeline rendering requires the jobs provider')
      await mkdir(root, { recursive: true })
      // Only producer-owned temporary files are removed; completed blocks survive retries and restart.
      for (const file of await readdir(root)) if (file.endsWith('.part')) await rm(join(root, file), { force: true })
      const deferred = Promise.withResolvers<JobOutcome>()
      const producer: { entry?: RenderEntry } = {}
      if (this.isDisposed()) throw new TimelineRenderError('renderer', 'timeline renderer is shutting down')
      const job = jobs.start({
        kind: 'media',
        owner: session.id,
        label: `Render timeline ${node} r${String(revision)}`,
        ...(completionNotice === undefined ? {} : { completionNotice }),
        run: () => ({
          done: deferred.promise,
          cancel: (_reason, cause) => {
            const entry = producer.entry
            if (entry !== undefined)
              void this.stop(entry, cause === 'teardown' ? 'interrupted' : 'cancelled', 'render stopped').catch((error: unknown) => {
                this.deps.report(error)
                deferred.resolve({ status: 'failed', detail: 'render cleanup failed' })
              },
              )
          },
        }),
      })
      const entry: RenderEntry = {
        owner: session,
        directory: target.directory,
        root,
        basePlan: target.plan,
        plan: target.plan,
        jobId: job,
        done: deferred.resolve,
        record: {
          version: 1,
          key: target.plan.key,
          contentKey: target.plan.key,
          revision,
          state: 'queued',
          progress: 0,
        },
        uploads: new Map(),
        receipts: new Map(),
        pending: new Set(),
        lease: undefined,
        touched: Date.now(),
        abort: new AbortController(),
      }
      producer.entry = entry
      this.entries.set(job, entry)
      this.byRoot.set(root, entry)
      if (live !== undefined) this.entries.delete(live.jobId)
      try {
        await this.save(entry)
      } catch (error: unknown) {
        this.entries.delete(job)
        this.byRoot.delete(root)
        deferred.resolve({ status: 'failed', detail: 'render journal could not be written' })
        throw error
      }
      return { revision, state: 'queued', progress: 0, jobId: job }
    })
  }

  /**
   * Reattach local rendering only; explicit cancellations and failed jobs stay terminal.
   * @param session - Session that owns the project and render task.
   * @param episode - Explicit episode; omission uses the Session binding.
   */
  async recover(session: Session, episode: EpisodeId): Promise<void> {
    const canvas = this.deps.canvas(),
      document = await canvas.read(session, episode)
    for (const node of document.nodes) {
      if (node.type !== 'timeline') continue
      const root = await this.location(session, node.id, episode)
      if (this.byRoot.has(root)) continue
      const record = await this.readRecord(root)
      if (record === undefined || !['queued', 'rendering', 'assembling', 'interrupted'].includes(record.state)) continue
      const timeline = await canvas.timeline(session, node.id, episode)
      if (timeline?.revision === record.revision)
        await this.start(session, node.id, record.revision, episode, undefined, 'none')
    }
  }

  /**
   * List unclaimed queued jobs owned by the Session.
   * @returns unclaimed jobs for the connected Session, including work queued before reconnect.
   * @param session - Session that owns the project and render task.
   */
  pending(session: Session): JobId[] {
    return [...this.entries.values()]
      .filter(entry => entry.owner.id === session.id && entry.record.state === 'queued')
      .map(entry => entry.jobId)
  }
  /**
   * Prepare only a pinned asset from this live plan; no caller-supplied filesystem path is accepted.
   * @param session - Session that owns the project and render task.
   * @param job - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param version - Immutable source version pinned by the render plan.
   * @returns The verified decodable source asset.
   */
  compatible(
    session: Session,
    job: JobId,
    lease: TimelineRenderLease,
    node: CanvasNodeId,
    version: VersionId,
  ): Promise<TimelineRenderAsset> {
    return this.accepted(async () => {
      const entry = this.active(session, job, lease)
      const asset = entry.plan.assets.find(candidate => candidate.node === node && candidate.version === version)
      if (asset === undefined) throw new TimelineRenderError('source', 'this asset is not part of the render plan')
      const pending = this.deps.compatible(asset, entry.directory, entry.abort.signal)
      entry.pending.add(pending)
      try {
        return await pending
      } finally {
        entry.pending.delete(pending)
      }
    })
  }

  /**
   * Acquire an exclusive writer lease and expose reusable cache blocks.
   * @returns a single upload lease and reusable blocks, or undefined when another renderer already owns it.
   * @param session - Session that owns the project and render task.
   * @param jobId - Opaque render job identity.
   * @param environment - Renderer codec and font environment identity.
   */
  async claim(session: Session, jobId: JobId, environment: string): Promise<TimelineRenderWork | undefined> {
    if (environment.length === 0 || environment.length > 4096)
      throw new TimelineRenderError('encoding', 'invalid renderer environment identity')
    const entry = this.owned(session, jobId)
    return this.serialized(entry.root, async () => {
      if (this.isDisposed() || entry.record.state !== 'queued' || entry.lease !== undefined) return undefined
      const keyFor = (content: string): TimelineCacheKey =>
        brandString<TimelineCacheKey>(
          createHash('sha256').update(JSON.stringify({ content, environment })).digest('hex'),
        )
      entry.plan = {
        ...entry.basePlan,
        key: keyFor(entry.basePlan.key),
        segments: entry.basePlan.segments.map(segment => ({ ...segment, key: keyFor(segment.key) })),
      }
      const segments = []
      for (const segment of entry.plan.segments) {
        const paths = {
          videoPath: join(entry.root, `${segment.key}.video.mp4`),
          audioPath: join(entry.root, `${segment.key}.pcm`),
        }
        const reusable = await this.cachedBlock(entry.root, segment.key)
        segments.push({ ...segment, ...paths, cached: reusable })
      }
      if (this.isDisposed()) return undefined
      entry.lease = brandString<TimelineRenderLease>(randomUUID())
      entry.abort = new AbortController()
      entry.touched = Date.now()
      entry.record = { ...entry.record, key: entry.plan.key, state: 'rendering' }
      await this.save(entry)
      return { lease: entry.lease, jobId, plan: { ...entry.plan, segments } }
    })
  }
  private async matches(path: string, value: unknown): Promise<boolean> {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('size' in value) ||
      !('modifiedMs' in value) ||
      !('hash' in value) ||
      typeof value.hash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.hash)
    )
      return false
    const info = await stat(path).catch((error: unknown) => {
      if (missing(error)) return undefined
      throw error
    })
    return info !== undefined && info.size === value.size && info.mtimeMs === value.modifiedMs
  }
  private owned(session: Session, jobId: JobId): RenderEntry {
    const entry = this.entries.get(jobId)
    if (entry === undefined || entry.owner.id !== session.id)
      throw new TimelineRenderError('lease', 'render job is unavailable to this Session')
    return entry
  }
  private async cachedBlock(root: string, key: TimelineCacheKey): Promise<boolean> {
    try {
      const receipt: unknown = JSON.parse(await readFile(join(root, `${key}.json`), 'utf8'))
      return (
        typeof receipt === 'object' &&
        receipt !== null &&
        'version' in receipt &&
        receipt.version === 1 &&
        'video' in receipt &&
        'audio' in receipt &&
        (await this.matches(join(root, `${key}.video.mp4`), receipt.video)) &&
        (await this.matches(join(root, `${key}.pcm`), receipt.audio))
      )
    } catch (error: unknown) {
      if (!missing(error))
        this.deps.report(new TimelineRenderError('storage', 'a damaged cache block will be rebuilt', { cause: error }))
      return false
    }
  }
  private async unchanged(entry: RenderEntry): Promise<boolean> {
    const latest = await this.deps.canvas().timeline(entry.owner, entry.plan.node, entry.plan.episode, entry.directory)
    return latest?.revision === entry.plan.document.revision && (await timelineInputsUnchanged(entry.plan))
  }
  private active(session: Session, jobId: JobId, lease: TimelineRenderLease): RenderEntry {
    const entry = this.owned(session, jobId)
    if (this.isDisposed() || terminal(entry.record.state) || entry.lease !== lease)
      throw new TimelineRenderError('lease', 'render lease expired; query the current job')
    entry.abort.signal.throwIfAborted()
    entry.touched = Date.now()
    return entry
  }
  private part(entry: RenderEntry, part: TimelineRenderPart): { readonly id: string; readonly target: string } {
    if (part.kind === 'output') return { id: 'output', target: join(entry.root, `${entry.plan.key}.mp4`) }
    if (!entry.plan.segments.some(segment => segment.key === part.segment))
      throw new TimelineRenderError('upload', 'unknown render block')
    const suffix = part.kind === 'video' ? '.video.mp4' : '.pcm'
    return { id: `${part.segment}/${part.kind}`, target: join(entry.root, `${part.segment}${suffix}`) }
  }

  /**
   * Stream bounded append-only writes. A stale lease cannot append to or publish a replacement job.
   * @param session - Session that owns the project and render task.
   * @param jobId - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param part - Host-issued segment or final-output upload identity.
   * @param offset - Expected append offset in bytes.
   * @param data - Base64-encoded bounded upload chunk.
   * @returns The accepted byte offset for the next upload.
   */
  appendEncoded(
    session: Session,
    jobId: JobId,
    lease: TimelineRenderLease,
    part: TimelineRenderPart,
    offset: number,
    data: string,
  ): Promise<number> {
    // The Remote protocol accepts byte arrays only in results. Bound base64 before allocating the input window.
    if (
      data.length > Math.ceil(this.deps.config.maxChunkBytes / 3) * 4 ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ) {
      return Promise.reject(new TimelineRenderError('upload', 'invalid encoded render upload window'))
    }
    return this.append(session, jobId, lease, part, offset, Buffer.from(data, 'base64'))
  }
  /**
   * Append decoded producer bytes after protocol validation.
   * @param session - Session that owns the project and render task.
   * @param jobId - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param part - Host-issued segment or final-output upload identity.
   * @param offset - Expected append offset in bytes.
   * @param bytes - Bounded encoded upload chunk.
   * @returns The accepted byte offset for the next upload.
   */
  async append(
    session: Session,
    jobId: JobId,
    lease: TimelineRenderLease,
    part: TimelineRenderPart,
    offset: number,
    bytes: Uint8Array,
  ): Promise<number> {
    const entry = this.owned(session, jobId)
    return this.serialized(entry.root, async () => {
      this.active(session, jobId, lease)
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        bytes.byteLength === 0 ||
        bytes.byteLength > entry.plan.maxChunkBytes
      ) {
        throw new TimelineRenderError('upload', 'invalid render upload window')
      }
      const { id, target } = this.part(entry, part)
      if (entry.receipts.has(id)) throw new TimelineRenderError('upload', 'this render part is already complete')
      let upload = entry.uploads.get(id)
      if (upload === undefined) {
        if (offset !== 0) throw new TimelineRenderError('upload', 'a render upload must begin at zero')
        const temporary = `${target}.${lease}.part`
        upload = { file: await open(temporary, 'wx'), temporary, target, size: 0, hash: createHash('sha256') }
        entry.uploads.set(id, upload)
      }
      if (offset !== upload.size)
        throw new TimelineRenderError('upload', 'render upload offset changed; restart this render')
      let written = 0
      while (written < bytes.byteLength) {
        const result = await upload.file.write(bytes, written, bytes.byteLength - written, offset + written)
        if (result.bytesWritten === 0) throw new TimelineRenderError('storage', 'render output could not be written')
        written += result.bytesWritten
      }
      upload.hash.update(bytes)
      upload.size += written
      return upload.size
    })
  }

  /**
   * Validate and atomically publish a completed part; incomplete video/PCM pairs are never reused.
   * @param session - Session that owns the project and render task.
   * @param jobId - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param part - Host-issued segment or final-output upload identity.
   * @returns The state after validating and publishing the uploaded part.
   */
  async complete(
    session: Session,
    jobId: JobId,
    lease: TimelineRenderLease,
    part: TimelineRenderPart,
  ): Promise<TimelineRenderView> {
    const entry = this.owned(session, jobId)
    return this.serialized(entry.root, async () => {
      this.active(session, jobId, lease)
      const { id } = this.part(entry, part),
        upload = entry.uploads.get(id)
      if (upload === undefined) throw new TimelineRenderError('upload', 'render part has no completed bytes')
      await upload.file.sync()
      await upload.file.close()
      if (part.kind === 'output') {
        if (!(await this.unchanged(entry))) {
          const message = 'timeline or source changed; render the current revision'
          entry.record = { ...entry.record, error: { code: 'source', message } }
          await this.stopLocked(entry, 'interrupted', message)
          return this.viewOf(entry.root, entry.basePlan)
        }
        for (const block of entry.plan.segments)
          if (!(await this.cachedBlock(entry.root, block.key))) {
            throw new TimelineRenderError('upload', 'render output arrived before its complete cache blocks')
          }
      }
      const segment =
        part.kind === 'output' ? undefined : entry.plan.segments.find(candidate => candidate.key === part.segment)
      if (part.kind === 'audio' && segment !== undefined) {
        const samples = timelineSegmentSamples(entry.plan.document, segment.fromFrame, segment.toFrame)
        if (upload.size !== samples.count * 2 * 4)
          throw new TimelineRenderError('probe', 'render PCM block length is incorrect')
      } else {
        const probe = await this.deps.ffmpeg.probe(upload.temporary, { signal: entry.abort.signal })
        const video = probe.streams?.find(stream => stream.codec_type === 'video')
        const expectedDuration =
          ((segment?.toFrame ?? entry.plan.frames) - (segment?.fromFrame ?? 0)) / entry.plan.document.spec.fps
        const duration = Number(video?.duration ?? probe.format?.duration)
        const [numerator, denominator] = (video?.avg_frame_rate ?? video?.r_frame_rate ?? '').split('/').map(Number)
        const frameRate = numerator === undefined || denominator === undefined ? NaN : numerator / denominator
        const expectedFrames = (segment?.toFrame ?? entry.plan.frames) - (segment?.fromFrame ?? 0)
        if (
          video?.codec_name !== 'h264' ||
          video.width !== entry.plan.document.spec.width ||
          video.height !== entry.plan.document.spec.height ||
          !Number.isFinite(frameRate) ||
          Math.abs(frameRate - entry.plan.document.spec.fps) > 0.001 ||
          (video.nb_frames !== undefined && video.nb_frames !== 'N/A' && Number(video.nb_frames) !== expectedFrames) ||
          !Number.isFinite(duration) ||
          Math.abs(duration - expectedDuration) > 1 / entry.plan.document.spec.fps + 0.03
        ) {
          throw new TimelineRenderError('probe', 'render video does not match its output specification')
        }
        if (part.kind === 'output') {
          const audio = probe.streams?.find(stream => stream.codec_type === 'audio')
          if (audio?.codec_name !== 'aac' || Number(audio.sample_rate) !== 48000 || audio.channels !== 2) {
            throw new TimelineRenderError('probe', 'render output is missing its stereo AAC mix')
          }
          const audioDuration = Number(audio.duration)
          if (
            !Number.isFinite(audioDuration) ||
            audioDuration < expectedDuration - 1 / entry.plan.document.spec.fps ||
            audioDuration > expectedDuration + 2048 / 48000 + 1 / entry.plan.document.spec.fps
          ) {
            throw new TimelineRenderError('probe', 'render output audio does not match the timeline duration')
          }
        }
      }
      entry.abort.signal.throwIfAborted()
      await rename(upload.temporary, upload.target)
      const info = await stat(upload.target)
      const receipt = { size: upload.size, modifiedMs: info.mtimeMs, hash: upload.hash.digest('hex') }
      entry.uploads.delete(id)
      entry.receipts.set(id, receipt)
      if (part.kind !== 'output') {
        const video = entry.receipts.get(`${part.segment}/video`),
          audio = entry.receipts.get(`${part.segment}/audio`)
        if (video !== undefined && audio !== undefined) {
          const metadata: SegmentReceipt = { version: 1, video, audio }
          await writeFileAtomic(join(entry.root, `${part.segment}.json`), JSON.stringify(metadata), {
            mode: 0o600,
            dirMode: 0o700,
          })
        }
      } else {
        if (!(await this.unchanged(entry))) {
          entry.record = {
            ...entry.record,
            state: 'interrupted',
            error: { code: 'source', message: 'timeline or source changed; render the current revision' },
          }
          await this.cleanup(entry)
          await this.save(entry)
          entry.done({ status: 'killed', detail: 'timeline or source changed; render the current revision' })
        } else {
          await this.cleanup(entry)
          entry.record = { ...entry.record, state: 'ready', progress: 1, output: receipt }
          await this.save(entry)
          entry.done({ status: 'completed', result: upload.target })
        }
      }
      return this.viewOf(entry.root, entry.basePlan)
    })
  }

  /**
   * Keep the lease alive and publish bounded progress to connected consumers.
   * @param session - Session that owns the project and render task.
   * @param jobId - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param progress - Normalized task progress from zero through one.
   * @param assembling - Whether the renderer is assembling the final full-quality output.
   */
  async progress(
    session: Session,
    jobId: JobId,
    lease: TimelineRenderLease,
    progress: number,
    assembling: boolean,
  ): Promise<void> {
    const entry = this.active(session, jobId, lease)
    await this.serialized(entry.root, async () => {
      this.active(session, jobId, lease)
      if (!Number.isFinite(progress) || progress < 0 || progress > 1)
        throw new TimelineRenderError('upload', 'invalid render progress')
      entry.record = { ...entry.record, progress, state: assembling ? 'assembling' : 'rendering' }
      await this.save(entry)
    })
  }
  /**
   * Fail the owned lease visibly; completed cache blocks remain reusable on explicit retry.
   * @param session - Session that owns the project and render task.
   * @param jobId - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param code - Structured render failure category.
   * @param message - Actionable render failure description.
   */
  async fail(
    session: Session,
    jobId: JobId,
    lease: TimelineRenderLease,
    code: TimelineRenderErrorCode,
    message: string,
  ): Promise<void> {
    const entry = this.owned(session, jobId)
    if (entry.lease !== lease) return
    entry.abort.abort()
    await this.serialized(entry.root, async () => {
      if (terminal(entry.record.state) || entry.lease !== lease) return
      entry.record = { ...entry.record, state: 'failed', error: { code, message } }
      try {
        await this.cleanup(entry)
        await this.save(entry)
      } finally {
        entry.done({ status: 'failed', detail: message })
      }
    })
  }
  private async cleanup(entry: RenderEntry): Promise<void> {
    await Promise.allSettled(entry.pending)
    const uploads = [...entry.uploads.values()]
    entry.uploads.clear()
    const results = await Promise.allSettled(
      uploads.map(async (upload) => {
        await upload.file.close()
        await rm(upload.temporary, { force: true })
      }),
    )
    const errors = results.flatMap((result): unknown[] => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length !== 0) throw new AggregateError(errors, 'timeline temporary-file cleanup failed')
  }
  private async stop(entry: RenderEntry, state: 'cancelled' | 'interrupted' | 'failed', detail: string): Promise<void> {
    entry.abort.abort()
    await this.serialized(entry.root, () => this.stopLocked(entry, state, detail))
  }
  private async stopLocked(
    entry: RenderEntry,
    state: 'cancelled' | 'interrupted' | 'failed',
    detail: string,
  ): Promise<void> {
    if (terminal(entry.record.state)) return
    entry.record = { ...entry.record, state }
    try {
      await this.cleanup(entry)
      await this.save(entry)
    } catch (error: unknown) {
      entry.record = {
        ...entry.record,
        state: 'failed',
        error: { code: 'storage', message: 'render cleanup failed; close the application before retrying' },
      }
      try {
        await this.save(entry)
      } catch (journalError: unknown) {
        this.deps.report(journalError)
      }
      entry.done({ status: 'failed', detail: 'render cleanup failed; output was not published' })
      throw error
    }
    entry.done({ status: state === 'failed' ? 'failed' : 'killed', detail })
  }
  /** Fence a disconnected renderer before returning its unfinished work to the queue. */
  async expireLeases(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (
        entry.lease === undefined ||
        terminal(entry.record.state) ||
        Date.now() - entry.touched < this.deps.config.leaseTimeoutMs
      )
        continue
      try {
        await this.serialized(entry.root, async () => {
          if (terminal(entry.record.state) || Date.now() - entry.touched < this.deps.config.leaseTimeoutMs) return
          entry.abort.abort()
          await this.cleanup(entry)
          entry.lease = undefined
          entry.record = { ...entry.record, state: 'queued' }
          await this.save(entry)
        })
      } catch (error: unknown) {
        this.deps.report(error)
        await this.stop(entry, 'failed', 'disconnected renderer cleanup failed').catch((cleanupError: unknown) =>
        { this.deps.report(cleanupError) },
        )
      }
    }
  }
  /**
   * Clear only derived files after stopping their writer; source media and timeline documents remain intact.
   * @param session - Session that owns the project and render task.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param episode - Explicit episode; omission uses the Session binding.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   */
  clear(session: Session, node: CanvasNodeId, episode?: EpisodeId, expectedDirectory?: string): Promise<void> {
    return this.accepted(() => this.clearAccepted(session, node, episode, expectedDirectory))
  }
  private async clearAccepted(
    session: Session,
    node: CanvasNodeId,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<void> {
    const root = await this.location(session, node, episode, expectedDirectory),
      entry = this.byRoot.get(root)
    if (entry !== undefined) await this.stop(entry, 'cancelled', 'cache cleared')
    await this.serialized(root, async () => {
      await rm(root, { force: true, recursive: true })
      this.byRoot.delete(root)
    })
  }
  /**
   * Copy the exact preview bytes into immutable project output and mount the result once.
   * @param session - Session that owns the project and render task.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param revision - Reviewed timeline revision that must still be current.
   * @param episode - Explicit episode; omission uses the Session binding.
   * @param origin - Actor recorded as the output creator.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   * @returns The new output node and immutable exported file.
   */
  export(
    session: Session,
    node: CanvasNodeId,
    revision: number,
    episode?: EpisodeId,
    origin: 'agent' | 'user' = 'user',
    expectedDirectory?: string,
  ): Promise<TimelineExportResult> {
    return this.accepted(() => this.exportAccepted(session, node, revision, episode, origin, expectedDirectory))
  }
  private async exportAccepted(
    session: Session,
    node: CanvasNodeId,
    revision: number,
    episode: EpisodeId | undefined,
    origin: 'agent' | 'user',
    expectedDirectory?: string,
  ): Promise<TimelineExportResult> {
    const canvas = this.deps.canvas()
    const target = await resolveTimelinePlan(
      canvas,
      session,
      node,
      revision,
      this.deps.config,
      episode,
      expectedDirectory,
    )
    const root = await this.location(session, node, target.plan.episode, target.directory)
    return this.serialized(root, async () => {
      if (this.isDisposed()) throw new TimelineRenderError('renderer', 'timeline renderer is shutting down')
      const status = await this.viewOf(root, target.plan)
      if (status.state !== 'ready' || status.path === undefined)
        throw new TimelineRenderError('renderer', 'finish the current full-quality preview before exporting')
      const outputs = join(target.directory, '.canvas', 'exports')
      await mkdir(outputs, { recursive: true })
      const record = this.byRoot.get(root)?.record ?? (await this.readRecord(root))
      if (record?.output === undefined)
        throw new TimelineRenderError('storage', 'the completed render receipt is unavailable; render again')
      const path = join(outputs, `${node}-${target.plan.key}-${record.output.hash}.mp4`)
      const document = await canvas.read(session, target.plan.episode, target.directory)
      const existing = document.nodes.find(
        candidate => candidate.type === 'video' && candidate.versions?.some(version => version.path === path),
      )
      if (existing !== undefined) {
        await canvas.edit(session, [], {
          baseRevision: document.revision,
          episode: target.plan.episode,
          expectedDirectory: target.directory,
          timelineRevisions: [{ node, revision }],
        })
        return { node: existing.id, path, revision }
      }
      const temporary = `${path}.${randomUUID()}.part`
      try {
        await pipeline(createReadStream(status.path), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), {
          signal: this.shutdown.signal,
        })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
      const source = document.nodes.find(candidate => candidate.id === node)
      const result = await canvas.edit(
        session,
        [
          { op: 'add', type: 'video', title: `${source?.title ?? node} MP4`, path, ref: 'render-output' },
          { op: 'connect', from: node, to: 'render-output' },
        ],
        {
          baseRevision: document.revision,
          episode: target.plan.episode,
          origin,
          expectedDirectory: target.directory,
          timelineRevisions: [{ node, revision }],
        },
      )
      const exported = result.refs['render-output']
      if (result.skipped.length !== 0 || exported === undefined)
        throw new TimelineRenderError(
          'storage',
          'render output could not be attached to the canvas; read the current canvas and retry',
        )
      return { node: exported, path, revision }
    })
  }
  /** Abort local probes, close upload handles and preserve restartable job state before unloading. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.shutdown.abort()
    for (const entry of this.entries.values()) entry.abort.abort()
    await Promise.allSettled(this.requests)
    const results = await Promise.allSettled(
      [...this.entries.values()].map(entry => this.stop(entry, 'interrupted', 'application closed')),
    )
    this.entries.clear()
    this.byRoot.clear()
    const errors = results.flatMap((result): unknown[] => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length !== 0) throw new AggregateError(errors, 'timeline renderer cleanup failed')
  }

  private isDisposed(): boolean {
    return this.disposed
  }
}
