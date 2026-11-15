/** One Session's canvas as the tab reads and edits it through the `canvas` Remote namespace. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CanvasDocument,
  CanvasEditResult,
  CanvasOperation,
  CanvasScope,
  CanvasView,
} from '@deepseek-ai/dsh-canvas/client'

/** Callbacks for edits that the Host accepted. */
export interface CanvasEditOptions {
  /** Scope captured by the initiating view; a mismatch refuses the queued write. */
  readonly scope?: CanvasScope
  /** Records a known accepted write, even when its following reread fails. */
  readonly onAcknowledged?: (
    document: CanvasDocument,
    operations: readonly CanvasOperation[],
    result: CanvasEditResult,
  ) => void
  /** Revision captured when a form validated its field baselines; never silently replace it. */
  readonly baseRevision?: number
  /** Runs after a successful reread, with the document used for the accepted write. */
  readonly onApplied?: (
    document: CanvasDocument,
    operations: readonly CanvasOperation[],
    result: CanvasEditResult,
  ) => void
}

/** What the tab draws. */
export interface CanvasState {
  /** `loading` until the first read settles; `failed` while the latest read failed. */
  readonly status: 'loading' | 'ready' | 'failed'
  /** Latest document read; kept through a later failed read. */
  readonly view: CanvasView | undefined
  /** Why the latest read failed. */
  readonly error: string | undefined
  /** Why the latest edit did not fully apply. */
  readonly notice: string | undefined
  /** Whether the last edit lost to a concurrent writer; the form keeps the user's input. */
  readonly conflict: boolean
  /** Stable identity of a refused context change; the UI owns its localized report. */
  readonly noticeCode?: 'scope' | 'unknown' | undefined
}

/** The two Remote calls of one Session's canvas. */
export interface CanvasRemote {
  /** @returns the Session's canvas, or the Host's failure. */
  readonly get: () => Promise<RemoteResult<CanvasView>>
  /**
   * @param operations - edits applied in one write.
   * @param baseRevision - document revision the edits were computed from.
   * @returns created ids and skipped operations, or the Host's failure.
   */
  readonly apply: (
    operations: CanvasOperation[],
    baseRevision: number,
    scope: CanvasScope,
  ) => Promise<RemoteResult<CanvasEditResult>>
}

/** Reads, edits, and change notifications of one Session's canvas. */
export class CanvasSource {
  /** The canvas as last read, with its load status and the notice of the last edit. */
  readonly state = createSnapshotStore<CanvasState>({
    status: 'loading',
    view: undefined,
    error: undefined,
    notice: undefined,
    conflict: false,
  })
  /** Only the latest read publishes. */
  private generation = 0
  private connection = 0
  private disposed = false
  /** Edits settle in order so each write observes the revision left by the previous one. */
  private editQueue: Promise<void> = Promise.resolve()

  /** @param remote - the Session's canvas calls. */
  constructor(private readonly remote: CanvasRemote) {}

  /** Read the canvas; a document already shown stays visible meanwhile and through a failure. */
  load = async (): Promise<void> => {
    if (this.disposed) return
    const generation = ++this.generation
    let result: RemoteResult<CanvasView>
    try {
      result = await this.remote.get()
    } catch (error: unknown) {
      if (generation !== this.generation) return
      this.state.set({
        ...this.state.getSnapshot(),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (generation !== this.generation) return
    const state = this.state.getSnapshot()
    this.state.set(
      result.ok
        ? { ...state, status: 'ready', view: result.value, error: undefined }
        : { ...state, status: 'failed', error: result.error.message },
    )
  }

  /**
   * Apply edits, then read the document the Host settled on.
   * @param operations - edits applied in one write; an empty list does nothing.
   * @param options - captured scope, form revision, and accepted-write callbacks.
   * A queued scope or connection mismatch sends nothing and publishes `noticeCode: scope`.
   * A transport failure retains an uncertain outcome in `notice`; callers must reread before retrying.
   */
  edit = async (operations: readonly CanvasOperation[], options?: CanvasEditOptions): Promise<void> => {
    if (this.disposed) return
    if (operations.length === 0) return
    const view = this.state.getSnapshot().view
    const scope =
      options?.scope ?? (view === undefined ? undefined : { directory: view.directory, episode: view.episode.id })
    const connection = this.connection
    const current = this.editQueue.then(async () => {
      await this.apply(operations, options, scope, connection)
    })
    this.editQueue = current.catch((_error: unknown) => undefined) // A failed caller does not poison later queued edits.
    await current
  }

  private apply = async (
    operations: readonly CanvasOperation[],
    options?: CanvasEditOptions,
    scope?: CanvasScope,
    connection = this.connection,
  ): Promise<void> => {
    if (this.disposed) return
    const matches = (): boolean => {
      const current = this.state.getSnapshot().view
      return (
        connection === this.connection &&
        scope !== undefined &&
        current?.directory === scope.directory &&
        current.episode.id === scope.episode
      )
    }
    if (!matches() || scope === undefined || this.state.getSnapshot().status !== 'ready') {
      this.state.set({
        ...this.state.getSnapshot(),
        notice: 'Canvas context changed; no edit was submitted. Reload and verify the target.',
        noticeCode: 'scope',
        conflict: false,
      })
      return
    }
    const document = this.state.getSnapshot().view?.document
    const baseRevision = options?.baseRevision ?? document?.revision ?? 0
    let result: RemoteResult<CanvasEditResult>
    try {
      result = await this.remote.apply([...operations], baseRevision, scope)
    } catch (error: unknown) {
      if (!matches()) return
      this.state.set({
        ...this.state.getSnapshot(),
        notice: error instanceof Error ? error.message : String(error),
        noticeCode: 'unknown',
        conflict: false,
      })
      await this.load()
      return
    }
    if (!matches()) return
    if (result.ok && document !== undefined) options?.onAcknowledged?.(document, operations, result.value)
    const notice = result.ok ? result.value.skipped[0]?.reason : result.error.message
    const conflict = !result.ok && result.error.code === 'canvas/conflict'
    this.state.set({ ...this.state.getSnapshot(), notice, noticeCode: undefined, conflict })
    await this.load()
    if (result.ok && document !== undefined && matches() && this.state.getSnapshot().status === 'ready')
      options?.onApplied?.(document, operations, result.value)
  }

  /** Clear the edit notice. */
  dismiss = (): void => {
    this.state.set({ ...this.state.getSnapshot(), notice: undefined, noticeCode: undefined, conflict: false })
  }

  /**
   * Read again when the changed project is the one shown.
   * @param directory - project directory whose canvas was rewritten.
   */
  changed(directory: string): void {
    if (this.state.getSnapshot().view?.directory === directory) void this.load()
  }

  /** Forget everything read through a replaced connection and read again. */
  reset(): void {
    if (this.disposed) return
    this.connection += 1
    this.state.set({ status: 'loading', view: undefined, error: undefined, notice: undefined, conflict: false })
    void this.load()
  }

  /** Stop any read in flight from publishing. */
  dispose(): void {
    this.disposed = true
    this.connection += 1
    this.generation += 1
  }
}
