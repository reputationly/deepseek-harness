/** Session-owned timeline reads, revision-checked commands, and local render actions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult, TimelineExportResult, TimelineRenderView } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CanvasNodeId,
  EpisodeId,
  Timeline,
  TimelineEditResult,
  TimelineOperation,
  TimelineRevision,
  TimelineRestoreMode,
} from '@deepseek-ai/dsh-canvas/client'

/** A form captures both project and episode; changing the Session binding cannot redirect its commands. */
export interface TimelineBinding {
  readonly directory: string
  readonly episode: EpisodeId
}

/**
 * A visible failure or recovery decision that preserves the associated local operations.
 */
export interface TimelineNotice {
  readonly kind: 'read' | 'edit' | 'conflict' | 'unknown' | 'render' | 'export' | 'unavailable' | 'history'
  readonly message: string | undefined
}
/**
 * The scoped document, pending edits, render status, and recovery state observed by the editor.
 */
export interface TimelineState {
  readonly node: CanvasNodeId | undefined
  readonly binding: TimelineBinding | undefined
  readonly document: Timeline | undefined
  readonly render: TimelineRenderView | undefined
  readonly loading: boolean
  readonly working: boolean
  readonly available: boolean
  readonly trusted: boolean
  readonly notice: TimelineNotice | undefined
  /** Rejected commands remain available until explicit merge or discard. */
  readonly pending: readonly TimelineOperation[]
  readonly exported: TimelineExportResult | undefined
  readonly history: readonly TimelineRevision[] | undefined
}
/** Undefined media replies explicitly mean the optional local renderer is unavailable. */
export interface TimelinePort {
  readonly get: (node: CanvasNodeId, binding: TimelineBinding) => Promise<RemoteResult<Timeline | undefined>>
  readonly edit: (
    node: CanvasNodeId,
    operations: TimelineOperation[],
    revision: number,
    spec: Timeline['spec'] | undefined,
    binding: TimelineBinding,
  ) => Promise<RemoteResult<TimelineEditResult>>
  readonly history: (node: CanvasNodeId, binding: TimelineBinding) => Promise<RemoteResult<readonly TimelineRevision[]>>
  readonly restore: (
    node: CanvasNodeId,
    revision: number,
    baseRevision: number,
    mode: TimelineRestoreMode,
    binding: TimelineBinding,
  ) => Promise<RemoteResult<TimelineEditResult>>
  readonly status: (
    node: CanvasNodeId,
    binding: TimelineBinding,
  ) => Promise<RemoteResult<TimelineRenderView> | undefined>
  readonly start: (
    node: CanvasNodeId,
    revision: number,
    binding: TimelineBinding,
  ) => Promise<RemoteResult<TimelineRenderView> | undefined>
  readonly cancel: (job: NonNullable<TimelineRenderView['jobId']>) => Promise<RemoteResult<boolean> | undefined>
  readonly clear: (node: CanvasNodeId, binding: TimelineBinding) => Promise<RemoteResult<void> | undefined>
  readonly export: (
    node: CanvasNodeId,
    revision: number,
    binding: TimelineBinding,
  ) => Promise<RemoteResult<TimelineExportResult> | undefined>
  readonly report: (error: unknown) => void
}
/**
 * Create an unopened editor state with no trusted document or active operation.
 * @returns A fresh editor state with no project binding.
 */
export const emptyTimelineState = (): TimelineState => ({
  node: undefined,
  binding: undefined,
  document: undefined,
  render: undefined,
  loading: false,
  working: false,
  available: false,
  trusted: false,
  notice: undefined,
  pending: [],
  exported: undefined,
  history: undefined,
})

/** Plain callbacks passed to the editor; the observable is bound separately by the renderer. */
export type TimelineActions = Pick<
  TimelineSource,
  'open' | 'load' | 'edit' | 'merge' | 'discard' | 'render' | 'cancel' | 'clear' | 'export' | 'readHistory' | 'restore'
>

/** One selected timeline per canvas face; React receives its snapshot and stable commands. */
export class TimelineSource {
  /**
   * Observable editor state scoped to the currently opened timeline.
   */
  readonly state = createSnapshotStore<TimelineState>(emptyTimelineState())
  private generation = 0
  private lifetime = 0
  private closed = false
  private writes: Promise<void> = Promise.resolve()
  private readonly reads = new Set<Promise<void>>()
  private readonly actions = new Set<Promise<void>>()
  private readonly mutations = new Map<symbol, number>()
  private readonly drafts = new Map<string, Pick<TimelineState, 'pending' | 'notice'>>()
  constructor(private readonly port: TimelinePort) {}

  /** Change the opened node; an old read or write can never publish into the new selection. */
  open = async (node: CanvasNodeId, binding: TimelineBinding): Promise<void> => {
    if (this.isClosed()) return
    const current = this.state.getSnapshot()
    if (
      current.node !== node ||
      current.binding?.directory !== binding.directory ||
      current.binding.episode !== binding.episode
    ) {
      if (
        current.node !== undefined &&
        current.binding !== undefined &&
        (current.pending.length !== 0 || current.notice?.kind === 'unknown' || this.uncertain())
      ) {
        this.drafts.set(this.identity(current.node, current.binding), {
          pending: current.pending,
          notice: this.uncertain() ? { kind: 'unknown', message: undefined } : current.notice,
        })
      }
      this.lifetime++
      const identity = this.identity(node, binding),
        retained = this.drafts.get(identity)
      this.drafts.delete(identity)
      this.state.set({ ...emptyTimelineState(), ...retained, node, binding })
    }
    await this.load()
  }
  /** Read current data without clearing a rejected edit or the form that owns its draft. */
  load = (): Promise<void> => {
    const { node, binding } = this.state.getSnapshot()
    if (this.isClosed() || node === undefined || binding === undefined) return Promise.resolve()
    const generation = ++this.generation,
      lifetime = this.lifetime
    this.state.set({ ...this.state.getSnapshot(), loading: true })
    const pending = (async () => {
      try {
        const document = await this.port.get(node, binding)
        if (this.isClosed() || lifetime !== this.lifetime || generation !== this.generation) return
        const render = document.ok ? await this.port.status(node, binding) : undefined
        if (this.isClosed() || lifetime !== this.lifetime || generation !== this.generation) return
        const state = this.state.getSnapshot()
        if (!document.ok)
          this.state.set({
            ...state,
            loading: false,
            trusted: false,
            render: undefined,
            notice: { kind: 'read', message: document.error.message },
          })
        else
          this.state.set({
            ...state,
            loading: false,
            trusted: true,
            document: document.value,
            render: render?.ok === true ? render.value : undefined,
            available: render !== undefined,
            history: state.document?.revision === document.value?.revision ? state.history : undefined,
            notice:
              render?.ok === false && document.value !== undefined
                ? { kind: 'render', message: render.error.message }
                : state.notice?.kind === 'read' ||
                    state.notice?.kind === 'render' ||
                    state.notice?.kind === 'unavailable'
                  ? undefined
                  : state.notice,
          })
        if (document.ok && document.value !== undefined && state.document?.revision !== document.value.revision)
          await this.readHistory()
      } catch (error: unknown) {
        this.port.report(error)
        if (!this.isClosed() && lifetime === this.lifetime && generation === this.generation)
          this.state.set({
            ...this.state.getSnapshot(),
            loading: false,
            trusted: false,
            render: undefined,
            notice: { kind: 'read', message: this.message(error) },
          })
      }
    })()
    this.reads.add(pending)
    void pending.finally(() => this.reads.delete(pending))
    return pending
  }

  /** Never substitutes a newer revision for the baseline captured by a form or gesture. */
  edit = (operations: readonly TimelineOperation[], revision: number, spec?: Timeline['spec']): Promise<boolean> => {
    if (operations.length === 0) return Promise.resolve(false)
    return this.commit(operations, (node, binding) => this.port.edit(node, [...operations], revision, spec, binding))
  }
  /** Restore intent keeps its captured revision; an unsuccessful call never substitutes a newer baseline. */
  restore = (revision: number, baseRevision: number, mode: TimelineRestoreMode): Promise<boolean> =>
    this.commit([], (node, binding) => this.port.restore(node, revision, baseRevision, mode, binding))

  private commit(
    operations: readonly TimelineOperation[],
    request: (node: CanvasNodeId, binding: TimelineBinding) => Promise<RemoteResult<TimelineEditResult>>,
  ): Promise<boolean> {
    const { node, binding } = this.state.getSnapshot(),
      lifetime = this.lifetime
    if (this.isClosed() || node === undefined || binding === undefined) return Promise.resolve(false)
    const current = this.writes.then(async () => {
      if (this.isClosed() || lifetime !== this.lifetime) return false
      this.generation++
      this.state.set({ ...this.state.getSnapshot(), working: true, pending: operations })
      const settle = this.mutation(lifetime)
      try {
        const result = await request(node, binding)
        if (this.isClosed() || lifetime !== this.lifetime) return false
        this.generation++
        const state = this.state.getSnapshot()
        if (result.ok) {
          if (state.document !== undefined && state.document.revision > result.value.document.revision) {
            this.state.set({ ...state, working: false, pending: [], notice: undefined })
            await this.load()
            return true
          }
          this.state.set({
            ...state,
            document: result.value.document,
            trusted: true,
            loading: false,
            working: false,
            pending: [],
            notice: undefined,
            history: undefined,
            render: { revision: result.value.document.revision, state: 'stale', progress: 0 },
          })
          await this.readHistory()
          return true
        }
        this.state.set({
          ...state,
          working: false,
          pending: operations,
          notice: {
            kind:
              result.error.code === 'canvas/conflict'
                ? 'conflict'
                : result.error.code === 'canvas/invalid-input'
                  ? 'edit'
                  : 'unknown',
            message: result.error.message,
          },
        })
        await this.load()
        return false
      } catch (error: unknown) {
        this.port.report(error)
        if (!this.isClosed() && lifetime === this.lifetime)
          this.state.set({
            ...this.state.getSnapshot(),
            working: false,
            loading: false,
            trusted: false,
            render: undefined,
            pending: operations,
            notice: { kind: 'unknown', message: this.message(error) },
          })
        return false
      } finally {
        settle()
      }
    })
    this.writes = current.then(() => undefined)
    return current
  }
  /** A separate user gesture merges the retained commands into the explicitly reloaded document. */
  merge = async (): Promise<boolean> => {
    const state = this.state.getSnapshot()
    if (state.document === undefined || state.pending.length === 0) return false
    return this.edit(state.pending, state.document.revision)
  }
  /**
   * Explicitly discard queued local operations and their recovery notice.
   */
  discard = (): void => {
    this.state.set({ ...this.state.getSnapshot(), pending: [], notice: undefined })
  }

  /** Metadata is refreshed on revisions and on explicit history reads, without polling snapshot bodies. */
  readHistory = (): Promise<void> =>
    this.action('history', async (state) => {
      if (state.node === undefined || state.binding === undefined) return undefined
      const result = await this.port.history(state.node, state.binding)
      if (!result.ok) return result
      const latest = result.value[0]?.revision
      if (latest !== undefined && latest !== this.state.getSnapshot().document?.revision) await this.load()
      return { ok: true, value: { history: result.value } }
    })

  /** Rendering and export stay Host-owned and always carry the revision the user reviewed. */
  render = (): Promise<void> =>
    this.action('render', async (state) => {
      if (state.node === undefined || state.document === undefined || state.binding === undefined) return undefined
      const result = await this.port.start(state.node, state.document.revision, state.binding)
      return result === undefined || !result.ok ? result : { ok: true, value: { render: result.value } }
    })
  /**
   * Cancel the current render through its Host task handle.
   */
  cancel = (): Promise<void> =>
    this.action('render', async (state) => {
      const id = state.render?.jobId
      if (id === undefined) return undefined
      const result = await this.port.cancel(id)
      if (result === undefined || !result.ok) return result
      await this.load()
      return { ok: true, value: {} }
    })
  /**
   * Stop the current renderer and clear only derived preview caches.
   */
  clear = (): Promise<void> =>
    this.action('render', async (state) => {
      if (state.node === undefined || state.binding === undefined) return undefined
      const result = await this.port.clear(state.node, state.binding)
      if (result === undefined || !result.ok) return result
      return { ok: true, value: { render: { revision: state.document?.revision ?? 0, state: 'stale', progress: 0 } } }
    })
  /**
   * Export the current ready preview and refresh the mounted output node.
   */
  export = (): Promise<void> =>
    this.action('export', async (state) => {
      if (state.node === undefined || state.document === undefined || state.binding === undefined) return undefined
      const result = await this.port.export(state.node, state.document.revision, state.binding)
      return result === undefined || !result.ok ? result : { ok: true, value: { exported: result.value } }
    })
  private action(
    kind: 'render' | 'export' | 'history',
    run: (state: TimelineState) => Promise<RemoteResult<Partial<TimelineState>> | undefined>,
  ): Promise<void> {
    const pending = this.performAction(kind, run)
    this.actions.add(pending)
    void pending.finally(() => this.actions.delete(pending))
    return pending
  }
  private async performAction(
    kind: 'render' | 'export' | 'history',
    run: (state: TimelineState) => Promise<RemoteResult<Partial<TimelineState>> | undefined>,
  ): Promise<void> {
    const state = this.state.getSnapshot(),
      lifetime = this.lifetime
    if (this.isClosed() || state.working) return
    this.state.set({
      ...state,
      working: true,
      notice: kind === 'history' && state.notice?.kind !== 'history' ? state.notice : undefined,
    })
    const settle = kind === 'history' ? undefined : this.mutation(lifetime)
    try {
      const result = await run(state)
      if (this.isClosed() || lifetime !== this.lifetime) return
      const current = this.state.getSnapshot()
      if (result === undefined)
        this.state.set({
          ...current,
          working: false,
          available: false,
          render: undefined,
          notice: { kind: 'unavailable', message: undefined },
        })
      else if (!result.ok)
        this.state.set({
          ...current,
          ...(kind === 'render' ? { render: undefined } : kind === 'history' ? { history: undefined } : {}),
          working: false,
          notice:
            kind === 'history' && current.notice !== undefined
              ? current.notice
              : { kind, message: result.error.message },
        })
      else if (kind === 'render' && state.document?.revision !== current.document?.revision) {
        this.state.set({ ...current, working: false })
        await this.load()
      } else this.state.set({ ...current, ...result.value, working: false })
    } catch (error: unknown) {
      this.port.report(error)
      if (!this.isClosed() && lifetime === this.lifetime)
        this.state.set({
          ...this.state.getSnapshot(),
          ...(kind === 'render' ? { render: undefined } : kind === 'history' ? { history: undefined } : {}),
          working: false,
          notice: { kind: kind === 'history' ? 'history' : 'unknown', message: this.message(error) },
        })
    } finally {
      settle?.()
    }
  }
  private mutation(lifetime: number): () => void {
    const token = Symbol()
    this.mutations.set(token, lifetime)
    return () => {
      this.mutations.delete(token)
    }
  }
  private uncertain(): boolean {
    return [...this.mutations.values()].includes(this.lifetime)
  }
  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
  private identity(node: CanvasNodeId, binding: TimelineBinding): string {
    return JSON.stringify([binding.directory, binding.episode, node])
  }
  /** Connection replacement invalidates shown files and every response from the prior generation. */
  reset(): void {
    const { node, binding, pending, notice } = this.state.getSnapshot(),
      uncertain = this.uncertain()
    this.lifetime++
    this.generation++
    this.state.set({
      ...emptyTimelineState(),
      node,
      binding,
      pending,
      notice: uncertain ? { kind: 'unknown', message: undefined } : notice,
    })
    void this.load()
  }
  /** Close admission and join accepted requests; Host operations retain their own transaction ownership. */
  async dispose(): Promise<void> {
    this.closed = true
    this.lifetime++
    await this.writes
    await Promise.allSettled([...this.reads, ...this.actions])
  }

  private isClosed(): boolean {
    return this.closed
  }
}
