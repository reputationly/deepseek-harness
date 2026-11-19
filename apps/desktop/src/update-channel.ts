/** Resolve the update channel sealed into the installed application manifest. */
import type { DesktopUpdatePreferences } from './settings-file.ts'

/** Installer-owned channel, independent of release version and upload environment. */
export type DesktopUpdateChannel = DesktopUpdatePreferences['channel']

/**
 * Read the packaged channel; older manifests retain their existing nightly behavior.
 * @param manifest Parsed application manifest.
 * @returns Validated channel. Invalid explicit values reject instead of changing feeds.
 */
export function desktopUpdateChannel(manifest: unknown): DesktopUpdateChannel {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop update: invalid application manifest')
  if (!('dshDesktopUpdateChannel' in manifest)) return 'nightly'
  const channel = manifest.dshDesktopUpdateChannel
  if (channel !== 'nightly' && channel !== 'stable') throw new Error('desktop update: invalid packaged channel')
  return channel
}

/**
 * Read whether this build can only hand an installer to the user instead of replacing itself.
 *
 * Unsigned builds land here: macOS rejects an adhoc signature while applying an in-place update,
 * and the Windows verifier rejects an unsigned updater, so those builds download the published
 * installer and open it.
 * @param manifest Parsed application manifest.
 * @returns `true` when the build ships the manual handoff.
 */
export function desktopManualUpdate(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop update: invalid application manifest')
  return 'dshDesktopManualUpdate' in manifest && (manifest as { dshDesktopManualUpdate?: unknown }).dshDesktopManualUpdate === true
}
