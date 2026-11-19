/** Globals of the two pages the desktop pet touches: the application page and the pet window. */
import type { PetHostBridge } from './pet-host-bridge.ts'
import type { PetWindowState } from './pet-window-policy.ts'

/** Snapshot the pet plugin publishes through `window.dshPet`. */
export interface PetPluginSnapshot {
  pet: { id: string; url: string } | null
  config: { visible: boolean }
  language: string
  notifications: { activity: unknown; items: { id: string; token: string }[] }
}

/** Version 1 of the pet plugin's public interface. */
export interface PetPluginApi {
  version: number
  getSnapshot: () => PetPluginSnapshot | null
  subscribe: (listener: () => void) => () => void
  acquireDisplay: () => () => void
  command: (value: unknown) => Promise<void>
  updateConfig: (value: unknown) => Promise<void>
  openSettings: () => void
}

/** Bridge the pet window preload publishes as `window.petWindow`. */
export interface PetWindowBridge {
  onState: (listener: (state: PetWindowState) => void) => () => void
  onCursor: (listener: (value: { dx: number; dy: number } | null) => void) => () => void
  ready: () => void
  pointer: (interactive: boolean) => void
  move: (dx: number, dy: number) => void
  command: (value: unknown) => Promise<void>
  action: (action: string) => void
}

declare global {
  interface Window {
    dshPet?: PetPluginApi
    dshPetHost?: PetHostBridge
    __disposePetAdapter?: () => void
    petWindow: PetWindowBridge
  }
}
