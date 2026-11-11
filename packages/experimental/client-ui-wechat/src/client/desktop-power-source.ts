/** WeChat's independent subscription to the Desktop power bridge. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

export interface WechatPowerState {
  readonly preventSleep: boolean
  readonly changing: boolean
}

export interface WechatPowerBridge {
  /** @returns The current shell-owned power preference. */
  get(): Promise<WechatPowerState>
  /** @param preventSleep - Whether to prevent system suspension while the app runs. */
  set(preventSleep: boolean): Promise<{ readonly kind: 'applied' | 'failed'; readonly state: WechatPowerState }>
  /** @param listener - Receives changes from any Desktop window. */
  subscribe(listener: (state: WechatPowerState) => void): () => void
}

export interface WechatPowerSnapshot {
  state?: WechatPowerState
  failed: boolean
  pending?: boolean
}

/** Client adapter for one WeChat settings card. */
export class WechatDesktopPowerSource {
  readonly store = createSnapshotStore<WechatPowerSnapshot>({ failed: false })
  private live = true
  private revision = 0
  private readonly unsubscribe: () => void

  private isLive(): boolean { return this.live }

  /** @param bridge - Isolated Desktop bridge, absent in Web. */
  constructor(private readonly bridge?: WechatPowerBridge) {
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
   * @param preventSleep - Whether the app should prevent system suspension.
   */
  async setPreventSleep(preventSleep: boolean): Promise<void> {
    if (!this.isLive() || this.bridge === undefined) return
    const previous = this.store.getSnapshot()
    if (previous.pending !== undefined) return
    const revision = this.revision
    this.store.set({ ...previous, pending: preventSleep, failed: false })
    let result: Awaited<ReturnType<WechatPowerBridge['set']>> | undefined
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
