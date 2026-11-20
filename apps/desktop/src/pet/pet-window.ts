/**
 * Native desktop pet window. The shell owns the window and its rendering, and consumes the pet plugin's public
 * `window.dshPet` interface from the application page. Adapted from MichengAI/dsh-codex-desktop (Apache-2.0).
 */
import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCHEME } from '../ipc.ts'
import { gazePayload } from './pet-gaze.ts'
import { installPetSourceAdapter } from './pet-source-adapter.ts'
import { petWindowHtml } from './pet-window-html.ts'
import {
  PET_IPC,
  PET_WINDOW_HEIGHT,
  PET_WINDOW_WIDTH,
  constrainPetBounds,
  parsePetWindowState,
  petWindowPlatformOptions,
  validPetCommand,
  type PetWindowState,
} from './pet-window-policy.ts'

/** What the pet window needs from the shell. */
export interface PetWindowOptions {
  /** Application page that hosts the pet plugin, when it exists. */
  source: () => WebContents | undefined
  /** Bring the application window forward for an action that continues there. */
  reveal: () => void
}

interface PendingCommand {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const COMMAND_TIMEOUT_MS = 15_000
const GAZE_INTERVAL_MS = 50
const POSITION_SAVE_DELAY_MS = 250
const PET_ACTIONS = ['hide', 'open', 'settings']

function isApplicationPage(contents: WebContents): boolean {
  const url = URL.parse(contents.getURL())
  return url?.protocol === `${SCHEME}:` && url.hostname === 'app'
}

/**
 * Show the selected pet in a transparent always-on-top window while the application page reports one.
 * @param options - the application page and the action that reveals its window.
 * @returns a disposer that closes the pet window and hands display back to the page.
 */
export function installPetWindow(options: PetWindowOptions): () => void {
  let window: BrowserWindow | undefined
  let state: PetWindowState | null = null
  let sourceOwner: WebContents | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let gazeTimer: ReturnType<typeof setInterval> | undefined
  let lastGazeKey = ''
  let disposed = false
  const pendingCommands = new Map<string, PendingCommand>()
  const positionFile = join(app.getPath('userData'), 'pet-position.json')
  const preload = fileURLToPath(new URL('./preload-pet.cjs', import.meta.url))

  const isSource = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.sender === options.source() && event.senderFrame === event.sender.mainFrame
  const isPet = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame

  const stopGaze = (): void => {
    if (gazeTimer !== undefined) clearInterval(gazeTimer)
    gazeTimer = undefined
    lastGazeKey = ''
  }
  const publishGaze = (): void => {
    if (window === undefined || window.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const bounds = window.getBounds()
    const payload = gazePayload(state, point, bounds)
    const key = payload === null ? 'off' : `${bounds.x},${bounds.y}|${point.x},${point.y}`
    if (key === lastGazeKey) return
    lastGazeKey = key
    window.webContents.send(PET_IPC.cursor, payload)
  }
  // The window ignores the mouse, so its page never sees the desktop cursor; the shell polls and forwards offsets.
  const send = (): void => {
    if (state === null || window === undefined || window.isDestroyed()) return
    window.webContents.send(PET_IPC.state, { ...state, sprite: undefined, pet: { ...state.pet, url: state.sprite } })
    gazeTimer ??= setInterval(publishGaze, GAZE_INTERVAL_MS)
    publishGaze()
  }
  const close = (): void => {
    stopGaze()
    for (const pending of pendingCommands.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('desktop pet: window closed'))
    }
    pendingCommands.clear()
    const old = window
    window = undefined
    if (old !== undefined && !old.isDestroyed()) old.destroy()
  }
  const release = (): void => {
    const source = options.source()
    if (source !== undefined && !source.isDestroyed()) source.send(PET_IPC.action, 'release')
  }

  const initialPosition = (): { x: number; y: number } => {
    const area = screen.getPrimaryDisplay().workArea
    let desired = { x: area.x + area.width - PET_WINDOW_WIDTH - 16, y: area.y + area.height - PET_WINDOW_HEIGHT - 16 }
    try {
      const stored = JSON.parse(readFileSync(positionFile, 'utf8')) as { x?: unknown; y?: unknown }
      if (typeof stored.x === 'number' && typeof stored.y === 'number' && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
        desired = { x: stored.x, y: stored.y }
      }
    } catch (_error: unknown) {
      // A first launch or an unreadable position file starts at the bottom-right corner.
    }
    return constrainPetBounds(desired, screen.getDisplayNearestPoint(desired).workArea)
  }
  const persistPosition = (): void => {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      if (window === undefined || window.isDestroyed()) return
      const { x, y } = window.getBounds()
      try {
        writeFileSync(`${positionFile}.tmp`, JSON.stringify({ x, y }), 'utf8')
        renameSync(`${positionFile}.tmp`, positionFile)
      } catch (error: unknown) {
        console.warn('desktop pet: could not save the window position', error)
      }
    }, POSITION_SAVE_DELAY_MS)
  }
  const clamp = (): void => {
    if (window === undefined || window.isDestroyed()) return
    const old = window.getBounds()
    const next = constrainPetBounds(old, screen.getDisplayNearestPoint(old).workArea)
    window.setPosition(next.x, next.y)
  }

  const open = async (): Promise<void> => {
    const platform = petWindowPlatformOptions(process.platform)
    const created = new BrowserWindow({
      ...initialPosition(),
      ...platform.window,
      width: PET_WINDOW_WIDTH,
      height: PET_WINDOW_HEIGHT,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      focusable: true,
      hasShadow: false,
      show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    window = created
    created.setVisibleOnAllWorkspaces(true, platform.workspaces)
    created.setIgnoreMouseEvents(true, { forward: true })
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.webContents.on('will-navigate', (navigation) => { navigation.preventDefault() })
    created.webContents.on('will-redirect', (navigation) => { navigation.preventDefault() })
    created.on('closed', () => { if (window === created) { window = undefined; close(); release() } })
    created.webContents.on('render-process-gone', () => { if (window === created) { close(); release() } })
    created.on('moved', persistPosition)
    try {
      await created.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(petWindowHtml())}`)
      if (window !== created) throw new Error('desktop pet: window closed while loading')
      created.showInactive()
      created.setAlwaysOnTop(true, 'floating')
      send()
    } catch (error: unknown) {
      if (window === created) close()
      throw error
    }
  }

  ipcMain.handle(PET_IPC.sync, async (event, value: unknown) => {
    // The page hands its pet back while it unloads, which during quit is after this window is gone.
    if (disposed) return
    if (!isSource(event) || !isApplicationPage(event.sender)) throw new Error('desktop pet: rejected an unknown source')
    if (value === null) { state = null; close(); return }
    const next = parsePetWindowState(value)
    if (next === null) throw new Error('desktop pet: invalid state')
    if (next.config.visible && next.sprite === undefined) throw new Error('desktop pet: the spritesheet is not ready')
    state = next
    sourceOwner = event.sender
    if (!next.config.visible) { close(); return }
    if (window === undefined) await open()
    else send()
  })
  ipcMain.handle(PET_IPC.command, async (event, command: unknown) => {
    if (!isPet(event) || !validPetCommand(command, state)) throw new Error('desktop pet: the notification changed or the action is invalid')
    const source = options.source()
    if (source === undefined || source.isDestroyed()) throw new Error('desktop pet: the application window is unavailable')
    if ((command as { type?: unknown }).type === 'open') options.reveal()
    const id = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(id)
        reject(new Error('desktop pet: the action was not confirmed'))
      }, COMMAND_TIMEOUT_MS)
      pendingCommands.set(id, { resolve, reject, timer })
      source.send(PET_IPC.command, id, command)
    })
  })

  const listeners: [string, (event: IpcMainEvent, ...values: unknown[]) => void][] = [
    [PET_IPC.commandResult, (event, id, error) => {
      if (!isSource(event) || typeof id !== 'string') return
      const pending = pendingCommands.get(id)
      if (pending === undefined) return
      pendingCommands.delete(id)
      clearTimeout(pending.timer)
      if (typeof error === 'string') pending.reject(new Error(error.slice(0, 1000)))
      else pending.resolve()
    }],
    [PET_IPC.ready, (event) => { if (isPet(event)) send() }],
    [PET_IPC.pointer, (event, interactive) => {
      if (isPet(event) && typeof interactive === 'boolean') window?.setIgnoreMouseEvents(!interactive, { forward: true })
    }],
    [PET_IPC.move, (event, dx, dy) => {
      if (!isPet(event) || window === undefined || typeof dx !== 'number' || typeof dy !== 'number') return
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 512 || Math.abs(dy) > 512) return
      const old = window.getBounds()
      const target = { x: old.x + dx, y: old.y + dy }
      const center = { x: target.x + PET_WINDOW_WIDTH / 2, y: target.y + PET_WINDOW_HEIGHT / 2 }
      const next = constrainPetBounds(target, screen.getDisplayNearestPoint(center).workArea)
      window.setPosition(next.x, next.y)
      // Windows reports `moved` only for moves the person makes through the window frame, which this window lacks.
      persistPosition()
    }],
    [PET_IPC.action, (event, action) => {
      if (!isPet(event) || typeof action !== 'string' || !PET_ACTIONS.includes(action)) return
      if (action !== 'hide') options.reveal()
      options.source()?.send(PET_IPC.action, action)
      if (action === 'hide') { state = null; close(); release() }
    }],
  ]
  for (const [channel, listener] of listeners) ipcMain.on(channel, listener)
  screen.on('display-removed', clamp)
  screen.on('display-metrics-changed', clamp)

  const watchers = new Map<WebContents, () => void>()
  const watch = (contents: WebContents): void => {
    if (watchers.has(contents) || contents.isDestroyed()) return
    const inject = (): void => {
      if (disposed || contents !== options.source() || contents.isDestroyed() || !isApplicationPage(contents)) return
      contents.executeJavaScript(`(${installPetSourceAdapter.toString()})()`).catch((error: unknown) => {
        if (disposed || contents !== options.source()) return
        close()
        release()
        console.warn('desktop pet: could not attach to the application page', error)
      })
    }
    const reset = (): void => {
      if (contents !== sourceOwner && contents !== options.source()) return
      sourceOwner = undefined
      state = null
      close()
    }
    // In-page routing keeps the plugin alive; only a new document drops the pet.
    const navigated = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (event.isMainFrame && !event.isSameDocument) reset()
    }
    const cleanup = (): void => {
      contents.removeListener('did-finish-load', inject)
      contents.removeListener('did-start-navigation', navigated)
      contents.removeListener('render-process-gone', reset)
      contents.removeListener('destroyed', destroyed)
      watchers.delete(contents)
    }
    const destroyed = (): void => { reset(); cleanup() }
    contents.on('did-finish-load', inject)
    contents.on('did-start-navigation', navigated)
    contents.on('render-process-gone', reset)
    contents.on('destroyed', destroyed)
    watchers.set(contents, cleanup)
    if (!contents.isLoading()) inject()
  }
  // The application window is created after this installs, and again after it is closed to the tray and reopened.
  const created = (_event: Electron.Event, contents: WebContents): void => {
    setImmediate(() => { if (!disposed && contents === options.source()) watch(contents) })
  }
  app.on('web-contents-created', created)
  const initial = options.source()
  if (initial !== undefined) watch(initial)

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    release()
    close()
    for (const cleanup of [...watchers.values()]) cleanup()
    app.removeListener('web-contents-created', created)
    app.removeListener('before-quit', dispose)
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    ipcMain.removeHandler(PET_IPC.command)
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener)
    screen.removeListener('display-removed', clamp)
    screen.removeListener('display-metrics-changed', clamp)
  }
  app.on('before-quit', dispose)
  return dispose
}
