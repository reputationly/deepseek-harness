/** One Session's canvas as the tab reads and edits it through the `canvas` Remote namespace. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { CanvasEditResult, CanvasOperation, CanvasView } from '@deepseek-ai/dsh-canvas/client'

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
  readonly apply: (operations: CanvasOperation[], baseRevision: number) => Promise<RemoteResult<CanvasEditResult>>
}

/** Reads, edits, and change notifications of one Session's canvas. */
export class CanvasSource {
  /** The canvas as last read, with its load status and the notice of the last edit. */
  readonly state = createSnapshotStore<CanvasState>({
    status: 'loading', view: undefined, error: undefined, notice: undefined, conflict: false,
  })
  /** Only the latest read publishes. */
  private generation = 0

  /** @param remote - the Session's canvas calls. */
  constructor(private readonly remote: CanvasRemote) {}

  /** Read the canvas; a document already shown stays visible meanwhile and through a failure. */
  load = async (): Promise<void> => {
    const generation = ++this.generation
    const result = await this.remote.get()
    if (generation !== this.generation) return
    const state = this.state.getSnapshot()
    this.state.set(result.ok
      ? { ...state, status: 'ready', view: result.value, error: undefined }
      : { ...state, status: 'failed', error: result.error.message })
  }

  /**
   * Apply edits, then read the document the Host settled on.
   * @param operations - edits applied in one write; an empty list does nothing.
   */
  edit = async (operations: readonly CanvasOperation[]): Promise<void> => {
    if (operations.length === 0) return
    const baseRevision = this.state.getSnapshot().view?.document.revision ?? 0
    let result: RemoteResult<CanvasEditResult>
    try {
      result = await this.remote.apply([...operations], baseRevision)
    } catch (error: unknown) {
      this.state.set({ ...this.state.getSnapshot(), notice: error instanceof Error ? error.message : String(error), conflict: false })
      await this.load()
      return
    }
    const notice = result.ok ? result.value.skipped[0]?.reason : result.error.message
    const conflict = !result.ok && result.error.code === 'canvas/conflict'
    this.state.set({ ...this.state.getSnapshot(), notice, conflict })
    await this.load()
  }

  /** Clear the edit notice. */
  dismiss = (): void => {
    this.state.set({ ...this.state.getSnapshot(), notice: undefined, conflict: false })
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
    this.state.set({ status: 'loading', view: undefined, error: undefined, notice: undefined, conflict: false })
    void this.load()
  }

  /** Stop any read in flight from publishing. */
  dispose(): void {
    this.generation += 1
  }
}
