/**
 * Manual installer handoff for builds Squirrel.Mac and the Windows NSIS verifier reject.
 *
 * An unsigned build cannot be replaced in place: macOS refuses the adhoc signature while applying
 * the update, and the installed copy stays on its old version. This module takes the other route —
 * download the artifact the feed already publishes, then hand it to the operating system so the
 * user runs the installer they are used to.
 *
 * @module update-manual-install
 */

import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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

/** Download-and-open handoff the coordinator drives instead of an in-place replacement. */
export interface ManualInstallPort {
  /**
   * Resolve this platform's installer for one version, download it, and verify it.
   * @param version - version the caller confirmed, checked against the published index.
   * @param onProgress - receives whole percentages while the artifact streams in.
   * @returns the saved path.
   */
  prepare(version: string, onProgress: (percent: number) => void): Promise<string>
  /**
   * Hand a downloaded installer to the operating system.
   * @param path - saved installer path.
   */
  open(path: string): Promise<void>
}

/** Inputs of one manual handoff. */
export interface ManualInstallOptions {
  /** Directory the installer is saved in, normally the user's downloads folder. */
  readonly directory: string
  /** Published index directory, the same one carrying `latest.json`. */
  readonly feedDirectory: string
  /** Transport, injected so tests own their bytes. */
  readonly send?: typeof fetch
  /** Opens a saved file the way the desktop shell does. */
  readonly openPath: (path: string) => Promise<string>
}

/**
 * Create the download-and-open handoff.
 * @param options - destination directory, transport, and the shell's open operation.
 * @returns the port the coordinator calls.
 */
export function createManualInstall(options: ManualInstallOptions): ManualInstallPort {
  const send = options.send ?? fetch
  return {
    async prepare(version, onProgress) {
      const index = await readIndex(options.feedDirectory, send)
      if (index.version !== version) {
        throw new Error(`desktop update: the feed offers ${index.version}, the confirmed target is ${version}`)
      }
      const asset = selectInstallerAsset(index.files, process.platform)
      if (asset === undefined) throw new Error('desktop update: the feed lists no installer for this platform')
      const target = `${options.directory}/${asset.name}`
      await mkdir(dirname(target), { recursive: true })
      const response = await send(asset.url)
      if (!response.ok) throw new Error(`desktop update: installer download answered HTTP ${String(response.status)}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (asset.size !== undefined && bytes.byteLength !== asset.size) {
        throw new Error(`desktop update: installer is ${String(bytes.byteLength)} bytes, the feed published ${String(asset.size)}`)
      }
      if (asset.sha256 !== undefined) {
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (digest !== asset.sha256) throw new Error('desktop update: installer SHA-256 does not match the published index')
      }
      onProgress(100)
      await writeFile(target, bytes)
      return target
    },
    async open(path) {
      const failure = await options.openPath(path)
      if (failure !== '') {
        await rm(path, { force: true })
        throw new Error(`desktop update: the installer could not be opened: ${failure}`)
      }
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
