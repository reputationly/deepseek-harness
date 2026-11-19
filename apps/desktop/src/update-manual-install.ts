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
  /** Published base64 SHA-512, checked against the download when the feed names it. */
  readonly sha512?: string
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
   * Download one installer and verify what the feed published about it.
   * @param asset - artifact to fetch.
   * @param onProgress - receives whole percentages while the artifact streams in.
   * @returns the saved path.
   */
  prepare(asset: InstallerAsset, onProgress: (percent: number) => void): Promise<string>
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
    async prepare(asset, onProgress) {
      const target = `${options.directory}/${asset.name}`
      await mkdir(dirname(target), { recursive: true })
      const response = await send(asset.url)
      if (!response.ok) throw new Error(`desktop update: installer download answered HTTP ${String(response.status)}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (asset.size !== undefined && bytes.byteLength !== asset.size) {
        throw new Error(`desktop update: installer is ${String(bytes.byteLength)} bytes, the feed published ${String(asset.size)}`)
      }
      if (asset.sha512 !== undefined) {
        const digest = createHash('sha512').update(bytes).digest('base64')
        if (digest !== asset.sha512) throw new Error('desktop update: installer SHA-512 does not match update metadata')
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
