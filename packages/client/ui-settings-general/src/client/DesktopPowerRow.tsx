/** Desktop keep-awake preference; the shell owns blocking and persistence. */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopPowerSource } from './desktop-power-source.ts'
import css from './DesktopPowerRow.module.css'

/** Framework-bound shell state and the explicit save action. */
export interface DesktopPowerRowInjected {
  hooks: { power: DesktopPowerSource['store'] }
  /**
   * @param preventSleep - Whether the shell should keep the system awake while it runs.
   */
  setPreventSleep(preventSleep: boolean): Promise<void>
}

/**
 * Render the Desktop-only keep-awake switch.
 * @param props - Shell observation, save action, and localized copy.
 * @returns the General settings row.
 */
export function DesktopPowerRow({ usePower, setPreventSleep, t }:
PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<DesktopPowerRowInjected>) {
  const { state, failed, pending } = usePower(value => value)
  const checked = pending ?? state?.preventSleep ?? false
  return <div className={css.row} role="group" aria-label={t('desktop.power.title')}>
    <div className={css.rowText}>
      <div className={css.title}>{t('desktop.power.title')}</div>
      <div className={css.description}>{t('desktop.power.description')}</div>
      {failed && <div className={css.error} role="alert">{t('desktop.power.error')}</div>}
    </div>
    <Switch checked={checked} label={t('desktop.power.title')} disabled={state === undefined || pending !== undefined}
      onChange={(next) => { void setPreventSleep(next) }} />
  </div>
}
