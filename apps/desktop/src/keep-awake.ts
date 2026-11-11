/** Owns the Electron system-suspension blocker for the Desktop app lifetime. */
import { powerSaveBlocker, type PowerSaveBlocker } from 'electron'

export class DesktopKeepAwake {
  private blockerId: number | undefined

  /** @param blocker - Electron power blocker, injectable for lifecycle tests. */
  constructor(private readonly blocker: Pick<PowerSaveBlocker, 'start' | 'stop' | 'isStarted'> = powerSaveBlocker) {}

  /** Whether the owned system-suspension blocker is active. */
  get active(): boolean {
    return this.blockerId !== undefined && this.blocker.isStarted(this.blockerId)
  }

  /**
   * Enable or disable prevention of system suspension.
   * @param on - Whether the app should keep the computer awake.
   */
  set(on: boolean): void {
    if (on) {
      if (this.active) return
      this.blockerId = this.blocker.start('prevent-app-suspension')
      return
    }
    this.dispose()
  }

  /** Stop the owned blocker when the Desktop app is quitting. */
  dispose(): void {
    const id = this.blockerId
    this.blockerId = undefined
    if (id !== undefined && this.blocker.isStarted(id)) this.blocker.stop(id)
  }
}
