import type { PetPluginApi, PetPluginSnapshot } from './pet-globals.ts'

/**
 * Attach the application page to the desktop pet window through the plugin's public interface. The shell injects
 * this function as source text, so it must not reference module scope. Adapted from MichengAI/dsh-codex-desktop
 * (Apache-2.0).
 */
export function installPetSourceAdapter(): void {
  type Snapshot = PetPluginSnapshot
  type Api = PetPluginApi
  const page = window
  page.__disposePetAdapter?.()
  const bridge = page.dshPetHost
  if (!bridge) return
  let api: Api | undefined,
    off: (() => void) | undefined,
    release: (() => void) | undefined
  let requested = 0,
    processed = 0,
    running = false,
    disposed = false
  let displayRevision = 0
  let imageUrl = '',
    imageData = ''
  const isDisposed = (): boolean => disposed
  const loadImage = async (pet: NonNullable<Snapshot['pet']>) => {
    if (pet.url !== `/dsh-codex-pet/asset/${encodeURIComponent(pet.id)}`)
      throw new Error('desktop pet: invalid spritesheet path')
    if (imageUrl === pet.url && imageData) return imageData
    const response = await fetch(pet.url, {
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`desktop pet: spritesheet request failed with ${response.status}`)
    const blob = await response.blob()
    if (
      !['image/png', 'image/webp'].includes(blob.type) ||
      blob.size > 16 * 1024 * 1024
    )
      throw new Error('desktop pet: invalid spritesheet type or size')
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result : '') }
      reader.onerror = () => { reject(new Error('desktop pet: could not read the spritesheet')) }
      reader.readAsDataURL(blob)
    })
    imageUrl = pet.url
    imageData = data
    return data
  }
  const releaseDisplay = () => {
    // Invalidate a takeover still waiting on sync, so a stale request cannot hide the in-page pet again.
    displayRevision++
    release?.()
    release = undefined
  }
  const pump = async () => {
    if (running) return
    running = true
    try {
      while (processed !== requested) {
        processed = requested
        const revision = processed,
          current = api,
          display = displayRevision
        try {
          const snapshot = current?.getSnapshot()
          const sprite =
            snapshot?.pet && snapshot.config.visible
              ? await loadImage(snapshot.pet)
              : undefined
          if (
            current !== api ||
            revision !== requested ||
            disposed ||
            display !== displayRevision
          ) {
            if (disposed) await bridge.sync(null)
            continue
          }
          await bridge.sync(
            snapshot?.pet
              ? {
                ...snapshot,
                sprite,
                activity: snapshot.notifications.activity,
              }
              : null,
          )
          // The page may have changed plugin, state, or takeover while the shell applied this one.
          if (current !== api || revision !== requested || isDisposed() || display !== displayRevision) continue
          if (snapshot?.pet && snapshot.config.visible)
            release ??= current?.acquireDisplay()
          else releaseDisplay()
        } catch (error) {
          releaseDisplay()
          console.warn('desktop pet: could not sync; the in-page pet is back', error)
          await bridge.sync(null).catch(() => {})
        }
      }
    } finally {
      running = false
    }
  }
  const update = () => {
    requested++
    void pump()
  }
  const connect = () => {
    if (disposed) return
    off?.()
    off = undefined
    releaseDisplay()
    imageUrl = ''
    imageData = ''
    api = page.dshPet?.version === 1 ? page.dshPet : undefined
    if (api) off = api.subscribe(update)
    update()
  }
  const offCommand = bridge.onCommand(async (command) => {
    if (!api) throw new Error('desktop pet: the pet plugin is not ready')
    await api.command(command)
  })
  const offAction = bridge.onAction((action) => {
    if (action === 'release') {
      releaseDisplay()
      return
    }
    if (action === 'hide') releaseDisplay()
    if (!api) return
    if (action === 'settings') api.openSettings()
    if (action === 'hide') {
      const current = api
      void Promise.resolve()
        .then(() => current.updateConfig({ visible: false }))
        .catch((error: unknown) => { console.warn('desktop pet: could not hide; the in-page pet is back', error) })
    }
    if (action === 'open') {
      const item = api.getSnapshot()?.notifications.items[0]
      if (item)
        void api
          .command({ type: 'open', id: item.id, token: item.token })
          .catch((error: unknown) => { console.warn('desktop pet: could not open the task', error) })
    }
  })
  window.addEventListener('dsh-pet-ready', connect)
  window.addEventListener('dsh-pet-disposed', connect)
  const dispose = () => {
    if (disposed) return
    disposed = true
    off?.()
    releaseDisplay()
    api = undefined
    update()
    offCommand()
    offAction()
    window.removeEventListener('dsh-pet-ready', connect)
    window.removeEventListener('dsh-pet-disposed', connect)
    window.removeEventListener('pagehide', dispose)
    if (page.__disposePetAdapter === dispose) delete page.__disposePetAdapter
  }
  page.__disposePetAdapter = dispose
  window.addEventListener('pagehide', dispose)
  connect()
}
