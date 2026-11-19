/** Application-page side of the desktop pet: forwards pet state to the shell and runs the commands it relays. */
import type { IpcRenderer } from 'electron'
import { PET_IPC } from './pet-window-policy.ts'

/** Bridge the application preload publishes as `window.dshPetHost`. */
export interface PetHostBridge {
  sync: (value: unknown) => Promise<void>
  onCommand: (listener: (command: unknown) => Promise<void>) => () => void
  onAction: (listener: (action: string) => void) => () => void
}

/**
 * Build the bridge between the pet plugin's page and the shell.
 * @param ipc - renderer IPC of the application window.
 * @returns the bridge to expose in the main world.
 */
export function createPetHostBridge(ipc: Pick<IpcRenderer, 'invoke' | 'send' | 'on' | 'removeListener'>): PetHostBridge {
  return {
    sync: value => ipc.invoke(PET_IPC.sync, value) as Promise<void>,
    onCommand: (listener) => {
      const handle = (_event: unknown, id: string, command: unknown): void => {
        listener(command).then(
          () => { ipc.send(PET_IPC.commandResult, id) },
          (error: unknown) => { ipc.send(PET_IPC.commandResult, id, error instanceof Error ? error.message : String(error)) },
        )
      }
      ipc.on(PET_IPC.command, handle)
      return () => { ipc.removeListener(PET_IPC.command, handle) }
    },
    onAction: (listener) => {
      const handle = (_event: unknown, action: string): void => { listener(action) }
      ipc.on(PET_IPC.action, handle)
      return () => { ipc.removeListener(PET_IPC.action, handle) }
    },
  }
}
