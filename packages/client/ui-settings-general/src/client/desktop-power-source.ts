/** General settings' subscription to the Desktop keep-awake bridge. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopPowerBridge, DesktopPowerState } from '../types.ts'

/**
 * Power preference, pending request and failure state observed by settings.
 */
export interface DesktopPowerSnapshot {
  state?: DesktopPowerState
  failed: boolean
  pending?: boolean
}

/** Client adapter for the General settings row. */
export class DesktopPowerSource {
  /**
   * Observable snapshot read by the power settings controls.
   */
  readonly store = createSnapshotStore<DesktopPowerSnapshot>({ failed: false })
  private live = true
  private revision = 0
  private readonly unsubscribe: () => void

  private isLive(): boolean { return this.live }

  /** @param bridge - Isolated Desktop bridge, absent in Web. */
  constructor(private readonly bridge?: DesktopPowerBridge) {
    this.unsubscribe = bridge?.subscribe((state) => {
      if (!this.live) return
      this.revision++
      this.store.set({ ...this.store.getSnapshot(), state, failed: false })
    }) ?? (() => {})
    if (bridge !== undefined) {
      void bridge.get().then((state) => {
        if (this.live && this.revision === 0) this.store.set({ state, failed: false })
      }, () => {
        if (this.live && this.revision === 0) this.store.set({ ...this.store.getSnapshot(), failed: true })
      })
    }
  }

  /**
   * Apply a keep-awake preference through the available Desktop bridge.
   * @param preventSleep - Whether the app should prevent system suspension.
   */
  async setPreventSleep(preventSleep: boolean): Promise<void> {
    if (!this.isLive() || this.bridge === undefined) return
    const previous = this.store.getSnapshot()
    if (previous.pending !== undefined) return
    const revision = this.revision
    this.store.set({ ...previous, pending: preventSleep, failed: false })
    let result: Awaited<ReturnType<DesktopPowerBridge['set']>> | undefined
    try { result = await this.bridge.set(preventSleep) } catch (_error) {
      // Transport failure has no confirmed state or user-facing diagnostic.
    }
    if (!this.isLive()) return
    const current = this.store.getSnapshot()
    const { pending: _pending, ...settled } = current
    this.store.set({
      ...settled,
      ...(result !== undefined && revision === this.revision ? { state: result.state } : {}),
      failed: result?.kind !== 'applied',
    })
  }

  /** Detach the bridge subscription and ignore late replies. */
  dispose(): void {
    this.live = false
    this.unsubscribe()
  }
}
