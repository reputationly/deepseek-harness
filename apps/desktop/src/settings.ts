/** Startup policy for optional Electron shell preferences, independent of the Host. */
import { DesktopSettingsFile, type DesktopPowerPreferences, type DesktopUpdatePreferences } from './settings-file.ts'

/** Resolved shell preferences; popup authorization and keep-awake failures are independent. */
export interface DesktopSettings {
  readonly updates: Pick<DesktopUpdatePreferences, 'allowTestAuthPopupWindow'>
  readonly power: DesktopPowerPreferences
}

/**
 * Initialize the shared document explicitly at startup, then resolve shell preferences.
 * @param userData - Electron userData, independent of DSH_HOME.
 * @returns Validated preferences, defaulting popup authorization and keep-awake to off on failure.
 */
export async function readDesktopSettings(userData: string): Promise<DesktopSettings> {
  const file = new DesktopSettingsFile(userData)
  const result = await file.initialize()
  const preference = result.kind === 'ready' ? result.fields.allowTestAuthPopupWindow : undefined
  const error = result.kind === 'error' ? result.error : preference?.kind === 'invalid' ? preference.error : undefined
  if (error) {
    try { console.warn(`desktop settings: ${file.path}: using defaults because settings could not be loaded`, error) } catch (_logError) {
      // Optional popup settings remain disabled even when diagnostic output is unavailable.
    }
  }
  const preventSleep = result.kind === 'ready' && result.fields.preventSleep.kind === 'valid'
    ? result.fields.preventSleep.value : false
  const powerError = result.kind === 'error' ? result.error
    : result.kind === 'ready' && result.fields.preventSleep.kind === 'invalid' ? result.fields.preventSleep.error : undefined
  if (powerError) {
    try { console.warn(`desktop settings: ${file.path}: using default power preferences`) } catch (_logError) {
      // Keep-awake remains disabled even when diagnostic output is unavailable.
    }
  }
  return {
    updates: { allowTestAuthPopupWindow: preference?.kind === 'valid' ? preference.value : false },
    power: { preventSleep },
  }
}
