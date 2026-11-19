/**
 * Installer handoff for unsigned builds that cannot use electron-updater.
 *
 * macOS opens the downloaded disk image while the application keeps running. Windows starts the
 * downloaded NSIS installer silently and lets it replace the running application after shutdown.
 *
 * @module update-manual-install
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One installer artifact as the update feed lists it. */
export interface InstallerAsset {
  /** Absolute URL inside the update origin. */
  readonly url: string
  /** File name the artifact is saved under. */
  readonly name: string
  /** Published byte size, checked against the download when the feed names it. */
  readonly size?: number
  /** Published SHA-256, checked against the download when the index names it. */
  readonly sha256?: string
}

/**
 * Pick the artifact a platform's users can run by hand.
 * @param files - artifacts the feed publishes for this target.
 * @param platform - platform whose installer is wanted.
 * @returns the installer artifact, or `undefined` when the feed lists none for this platform.
 */
export function selectInstallerAsset(
  files: readonly InstallerAsset[],
  platform: NodeJS.Platform,
): InstallerAsset | undefined {
  const suffix = platform === 'darwin' ? '.dmg' : platform === 'win32' ? '.exe' : undefined
  if (suffix === undefined) return undefined
  return files.find(file => file.name.toLowerCase().endsWith(suffix))
}

/** Download and platform-specific installer handoff driven by the coordinator. */
export interface ManualInstallPort {
  /** Whether installation replaces the running application in place. */
  readonly replacesInPlace: boolean
  /**
   * Resolve this platform's installer for one version, download it, and verify it.
   * @param version - version the caller confirmed, checked against the published index.
   * @param onProgress - receives whole percentages while the artifact streams in.
   * @returns the saved path.
   * Network interruptions resume with HTTP Range requests.
   * @throws If the feed, download, size, or digest is invalid. Partial downloads are removed.
   */
  prepare(version: string, onProgress: (percent: number) => void): Promise<string>
  /**
   * Open a downloaded installer without replacing the running application.
   * @param path - saved installer path.
   */
  open(path: string): Promise<void>
  /**
   * Start a silent Windows replacement and quit after the installer starts.
   * `/S` installs silently; `--updated` makes NSIS wait for the old process to exit; `--force-run`
   * makes the installer launch the updated application with `--updated` when installation finishes.
   * @param path - saved Windows installer path.
   * @throws If this platform does not support replacement or the installer cannot be started.
   */
  replace(path: string): Promise<void>
}

interface SpawnedInstaller {
  once(event: 'spawn', listener: () => void): this
  once(event: 'error', listener: (error: Error) => void): this
  unref(): void
}

type ManualInstallSpawn = (
  path: string,
  args: string[],
  options: { detached: true; stdio: 'ignore'; windowsHide: false },
) => SpawnedInstaller

class InstallerProcessingError extends Error {
  constructor(readonly error: unknown) {
    super('desktop update: installer download processing failed')
  }
}

/** Inputs of one manual handoff. */
export interface ManualInstallOptions {
  /** Directory the installer is saved in, normally the user's downloads folder. */
  readonly directory: string
  /** Whether the updater owns this directory and clears it before each download. */
  readonly ownsDirectory?: boolean
  /** Published index directory, the same one carrying `latest.json`. */
  readonly feedDirectory: string
  /** Platform used to select the installer and replacement behavior; defaults to the current platform. */
  readonly platform?: NodeJS.Platform
  /** Transport, injected so tests own their bytes. */
  readonly send?: typeof fetch
  /** Base wait in milliseconds before retrying an interrupted download. */
  readonly retryDelayMs?: number
  /** Opens a saved file the way the desktop shell does. */
  readonly openPath: (path: string) => Promise<string>
  /** Starts the Windows installer; defaults to `node:child_process`'s `spawn`. */
  readonly spawn?: ManualInstallSpawn
  /** Quits the desktop application after the replacement installer starts. */
  readonly quit: () => void
}

/**
 * Create the streamed installer download and platform-specific handoff.
 * @param options - destination, platform, transport, and shell operations.
 * @returns the port the coordinator calls.
 */
export function createManualInstall(options: ManualInstallOptions): ManualInstallPort {
  const send = options.send ?? fetch
  const platform = options.platform ?? process.platform
  const start = options.spawn ?? spawn
  const retryDelayMs = options.retryDelayMs ?? 1000
  return {
    replacesInPlace: platform === 'win32',
    async prepare(version, onProgress) {
      const index = await readIndex(options.feedDirectory, send)
      if (index.version !== version) {
        throw new Error(`desktop update: the feed offers ${index.version}, the confirmed target is ${version}`)
      }
      const asset = selectInstallerAsset(index.files, platform)
      if (asset === undefined) throw new Error('desktop update: the feed lists no installer for this platform')
      if (options.ownsDirectory) await rm(options.directory, { recursive: true, force: true })
      const target = `${options.directory}/${asset.name}`
      const temporary = `${target}.download`
      let downloaded = 0
      let lastProgress = 0
      try {
        await mkdir(dirname(target), { recursive: true })
        const handle = await open(temporary, 'w')
        try {
          let hash = createHash('sha256')
          let writePosition = 0
          let total: number | undefined
          let etag: string | undefined
          let firstResponse = true
          let firstRequest = true
          let consecutiveFailures = 0
          while (true) {
            const rangeRequest = !firstRequest
            let response: Response
            try {
              if (firstRequest) {
                firstRequest = false
                response = await send(asset.url)
              } else {
                response = await send(asset.url, {
                  headers: {
                    Range: `bytes=${downloaded}-`,
                    ...(etag === undefined ? {} : { 'If-Range': etag }),
                  },
                })
              }
            } catch (error) {
              consecutiveFailures += 1
              if (consecutiveFailures >= 5) throw error
              await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs * consecutiveFailures))
              continue
            }
            if (!response.ok) throw new Error(`desktop update: installer download answered HTTP ${String(response.status)}`)
            if (response.body === null) throw new Error('desktop update: installer download failed')
            if (firstResponse) {
              firstResponse = false
              etag = response.headers.get('etag') ?? undefined
              const contentLength = response.headers.get('content-length')
              const advertisedSize = asset.size ?? (contentLength === null ? undefined : Number(contentLength))
              total = advertisedSize !== undefined && Number.isFinite(advertisedSize) && advertisedSize > 0
                ? advertisedSize : undefined
            }
            if (response.status === 206) {
              if (!response.headers.get('content-range')?.startsWith(`bytes ${downloaded}-`)) {
                throw new Error('desktop update: installer resume response has an unexpected Content-Range')
              }
            } else if (rangeRequest && response.status === 200) {
              await handle.truncate(0)
              downloaded = 0
              writePosition = 0
              hash = createHash('sha256')
            }
            try {
              for await (const chunk of response.body) {
                try {
                  let offset = 0
                  while (offset < chunk.byteLength) {
                    const { bytesWritten } = await handle.write(
                      chunk, offset, chunk.byteLength - offset, writePosition + offset,
                    )
                    if (bytesWritten === 0) throw new Error('desktop update: installer download could not be written')
                    offset += bytesWritten
                  }
                  hash.update(chunk)
                  downloaded += chunk.byteLength
                  writePosition += chunk.byteLength
                  if (total !== undefined) {
                    const percent = Math.min(99, Math.floor(downloaded / total * 100))
                    if (percent > lastProgress) {
                      lastProgress = percent
                      onProgress(percent)
                    }
                  }
                } catch (error) {
                  throw new InstallerProcessingError(error)
                }
                consecutiveFailures = 0
              }
            } catch (error) {
              if (error instanceof InstallerProcessingError) throw error.error
              consecutiveFailures += 1
              if (consecutiveFailures >= 5) throw error
              await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs * consecutiveFailures))
              continue
            }
            break
          }
          if (asset.size !== undefined && downloaded !== asset.size) {
            throw new Error(`desktop update: installer is ${String(downloaded)} bytes, the feed published ${String(asset.size)}`)
          }
          if (asset.sha256 !== undefined && hash.digest('hex') !== asset.sha256) {
            throw new Error('desktop update: installer SHA-256 does not match the published index')
          }
        } finally {
          await handle.close()
        }
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      onProgress(100)
      return target
    },
    async open(path) {
      const failure = await options.openPath(path)
      if (failure !== '') {
        await rm(path, { force: true })
        throw new Error(`desktop update: the installer could not be opened: ${failure}`)
      }
    },
    async replace(path) {
      if (platform !== 'win32') throw new Error('desktop update: in-place replacement is only supported on Windows')
      await new Promise<void>((resolve, reject) => {
        const child = start(path, ['/S', '--updated', '--force-run'], {
          detached: true, stdio: 'ignore', windowsHide: false,
        })
        child.once('spawn', () => {
          child.unref()
          options.quit()
          resolve()
        })
        child.once('error', reject)
      })
    },
  }
}

/**
 * Remove the updater-owned installer directory, retrying removal failures.
 * NSIS may keep its own files open for a while after launching the updated application.
 * @param directory - Installer directory to remove.
 * @param options - Retry attempts, delay, and removal operation; defaults to 12 attempts, 10 seconds, and recursive forced removal.
 * @returns Resolves once the directory is removed.
 * @throws The last removal error if every attempt fails.
 */
export async function clearInstallerDirectory(
  directory: string,
  options?: {
    attempts?: number
    delayMs?: number
    remove?: (path: string) => Promise<void>
  },
): Promise<void> {
  const attempts = options?.attempts ?? 12
  const delayMs = options?.delayMs ?? 10_000
  const remove = options?.remove ?? (path => rm(path, { recursive: true, force: true }))
  if (attempts < 1) throw new RangeError('desktop update: directory cleanup needs at least one attempt')
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await remove(directory)
      return
    } catch (error) {
      lastError = error
      if (attempt + 1 < attempts) {
        await new Promise<void>(resolve => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}

/** One published index, in the fields the handoff reads. */
interface PublishedIndex {
  readonly version: string
  readonly files: readonly InstallerAsset[]
}

/**
 * Read the published index beside the update feed.
 * @param feedDirectory - directory the packaged update manifest points at.
 * @param send - transport.
 * @returns the version and installer entries it names.
 */
async function readIndex(feedDirectory: string, send: typeof fetch): Promise<PublishedIndex> {
  const response = await send(`${feedDirectory}/latest.json`)
  if (!response.ok) throw new Error(`desktop update: latest.json answered HTTP ${String(response.status)}`)
  const payload: unknown = await response.json()
  if (typeof payload !== 'object' || payload === null) throw new Error('desktop update: latest.json is not an object')
  const { version, files } = payload as { version?: unknown; files?: unknown }
  if (typeof version !== 'string' || version === '') throw new Error('desktop update: latest.json has no version')
  if (!Array.isArray(files)) throw new Error('desktop update: latest.json lists no files')
  return {
    version,
    files: files.flatMap((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return []
      const { name, url, size, sha256 } = entry as { name?: unknown; url?: unknown; size?: unknown; sha256?: unknown }
      if (typeof name !== 'string' || typeof url !== 'string' || name === '' || url === '') return []
      return [{
        name,
        url,
        ...(typeof size === 'number' ? { size } : {}),
        ...(typeof sha256 === 'string' ? { sha256 } : {}),
      }]
    }),
  }
}

/**
 * Read the update feed directory the packaged application polls.
 * @param resourcesPath - packaged `Resources` directory.
 * @param readFile - file reader, injected so tests need no packaged app.
 * @returns the directory URL, or `undefined` when the build carries no update source.
 */
export async function readFeedDirectory(
  resourcesPath: string,
  readFile: (path: string) => Promise<string>,
): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(`${resourcesPath}/app-update.yml`)
  } catch {
    return undefined
  }
  const match = /^url:\s*(\S+)\s*$/mu.exec(text)
  return match?.[1]
}
