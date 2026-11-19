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
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

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
        const response = await send(asset.url)
        if (!response.ok) throw new Error(`desktop update: installer download answered HTTP ${String(response.status)}`)
        if (response.body === null) throw new Error('desktop update: installer download failed')
        const contentLength = response.headers.get('content-length')
        const advertisedSize = asset.size ?? (contentLength === null ? undefined : Number(contentLength))
        const total = advertisedSize !== undefined && Number.isFinite(advertisedSize) && advertisedSize > 0
          ? advertisedSize : undefined
        const hash = createHash('sha256')
        await pipeline(
          Readable.from(response.body),
          new Transform({
            transform(chunk: Uint8Array, _encoding, callback) {
              try {
                hash.update(chunk)
                downloaded += chunk.byteLength
                if (total !== undefined) {
                  const percent = Math.min(99, Math.floor(downloaded / total * 100))
                  if (percent > lastProgress) {
                    lastProgress = percent
                    onProgress(percent)
                  }
                }
                callback(null, chunk)
              } catch (error) {
                callback(error instanceof Error ? error : new Error(String(error)))
              }
            },
          }),
          createWriteStream(temporary),
        )
        if (asset.size !== undefined && downloaded !== asset.size) {
          throw new Error(`desktop update: installer is ${String(downloaded)} bytes, the feed published ${String(asset.size)}`)
        }
        if (asset.sha256 !== undefined && hash.digest('hex') !== asset.sha256) {
          throw new Error('desktop update: installer SHA-256 does not match the published index')
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
