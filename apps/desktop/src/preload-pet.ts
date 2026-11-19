/** Bridge of the desktop pet window: pet state in, a fixed set of pet actions out. */
import { contextBridge, ipcRenderer } from 'electron'
import { PET_IPC } from './pet/pet-window-policy.ts'

function subscribe(channel: string, listener: (value: unknown) => void): () => void {
  const handle = (_event: Electron.IpcRendererEvent, value: unknown): void => { listener(value) }
  ipcRenderer.on(channel, handle)
  return () => { ipcRenderer.removeListener(channel, handle) }
}

contextBridge.exposeInMainWorld('petWindow', {
  command: (value: unknown) => ipcRenderer.invoke(PET_IPC.command, value) as Promise<void>,
  onState: (listener: (value: unknown) => void) => subscribe(PET_IPC.state, listener),
  onCursor: (listener: (value: unknown) => void) => subscribe(PET_IPC.cursor, listener),
  ready: () => { ipcRenderer.send(PET_IPC.ready) },
  pointer: (interactive: boolean) => { ipcRenderer.send(PET_IPC.pointer, interactive) },
  move: (dx: number, dy: number) => { ipcRenderer.send(PET_IPC.move, dx, dy) },
  action: (action: string) => { ipcRenderer.send(PET_IPC.action, action) },
})
