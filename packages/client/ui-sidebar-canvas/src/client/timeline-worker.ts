/** Plugin-owned rendering continues independently of which editor panel is mounted. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TimelineRenderNotice,
  TimelineRenderWork,
  TimelineRenderErrorCode,
} from '@deepseek-ai/dsh-api-remotes/client'
import { renderTimeline, type TimelineRenderIO } from './timeline-renderer.ts'
import { TimelineFrameError } from '@deepseek-ai/dsh-util-timeline-compositor'
import { TimelineRenderFailure } from './timeline-failure.ts'

type RenderId = TimelineRenderWork['jobId']
/**
 * Injected task discovery, lease, upload, and reporting operations of the renderer worker.
 */
export interface TimelineWorkerPort {
  readonly pending: (session: SessionId) => Promise<readonly RenderId[]>
  readonly claim: (session: SessionId, job: RenderId) => Promise<TimelineRenderWork | undefined>
  readonly io: (session: SessionId, work: TimelineRenderWork) => TimelineRenderIO
  readonly fail: (
    session: SessionId,
    work: TimelineRenderWork,
    code: TimelineRenderErrorCode,
    message: string,
  ) => Promise<void>
  readonly report: (error: unknown) => void
}

/** One local compositor runs at a time, bounding decoders and isolating its output/font lifetime. */
export class TimelineWorker {
  private readonly queue = new Map<RenderId, SessionId>()
  private readonly sessions = new Set<SessionId>()
  private readonly reads = new Set<Promise<void>>()
  private readonly discovery = new Map<SessionId, { readonly epoch: number; readonly read: Promise<void> }>()
  private running: { readonly job: RenderId; readonly controller: AbortController } | undefined
  private drain: Promise<void> | undefined
  private closed = false
  private epoch = 0
  constructor(private readonly port: TimelineWorkerPort) {}

  /**
   * Remember an open Session and discover work queued before this Client connected.
   * @param session - Session that owns the project and render task.
   */
  wake(session: SessionId): void {
    if (this.closed) return
    this.sessions.add(session)
    if (this.discovery.get(session)?.epoch === this.epoch) return
    const epoch = this.epoch
    const read = Promise.resolve()
      .then(() => this.port.pending(session))
      .then((jobs) => {
        if (this.closed || epoch !== this.epoch) return
        for (const job of jobs) this.queue.set(job, session)
        this.start()
      })
      .catch((error: unknown) => { this.port.report(error) })
    this.reads.add(read)
    this.discovery.set(session, { epoch, read })
    void read.finally(() => {
      this.reads.delete(read)
      if (this.discovery.get(session)?.read === read) this.discovery.delete(session)
    })
  }
  /**
   * Cancel fenced work before waking its replacement lease.
   * @param notice - Host notification identifying the changed render job and owner.
   */
  changed(notice: TimelineRenderNotice): void {
    if (this.closed) return
    this.sessions.add(notice.sessionId)
    if (['queued', 'cancelled', 'interrupted', 'failed'].includes(notice.state)) {
      if (this.running?.job === notice.jobId) this.running.controller.abort()
      this.queue.delete(notice.jobId)
    }
    if (notice.state === 'queued') {
      this.queue.set(notice.jobId, notice.sessionId)
      this.start()
    }
  }
  /** Stop codec work during transport replacement; the Host lease fences late writes. */
  reset(): void {
    this.epoch++
    this.running?.controller.abort()
    this.queue.clear()
    for (const session of this.sessions) this.wake(session)
  }
  private start(): void {
    if (this.drain !== undefined || this.closed) return
    this.drain = this.run().finally(() => {
      this.drain = undefined
      if (!this.closed && this.queue.size !== 0) this.start()
    })
  }
  private async run(): Promise<void> {
    while (!this.closed) {
      const next = this.queue.entries().next().value
      if (next === undefined) return
      const [job, session] = next
      this.queue.delete(job)
      const controller = new AbortController()
      this.running = { job, controller }
      let work: TimelineRenderWork | undefined
      try {
        work = await this.port.claim(session, job)
        if (work === undefined) continue
        controller.signal.throwIfAborted()
        controller.signal.throwIfAborted()
        await renderTimeline(work, this.port.io(session, work), controller.signal)
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          this.port.report(error)
          const code =
            error instanceof TimelineRenderFailure
              ? error.code
              : error instanceof TimelineFrameError
                ? 'source'
                : 'renderer'
          if (work !== undefined)
            await this.port
              .fail(session, work, code, error instanceof Error ? error.message : String(error))
              .catch((failure: unknown) => { this.port.report(failure) })
        }
      } finally {
        this.running = undefined
      }
    }
  }
  /** Close admission, cancel codecs and await every accepted queue read and render. */
  async dispose(): Promise<void> {
    this.closed = true
    this.queue.clear()
    this.running?.controller.abort()
    await Promise.allSettled(this.reads)
    await this.drain
    this.sessions.clear()
    this.discovery.clear()
  }
}
