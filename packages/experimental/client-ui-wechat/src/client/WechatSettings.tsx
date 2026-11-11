import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WechatSnapshot } from '@deepseek-ai/dsh-wechat/types'
import type { WechatDesktopPowerSource } from './desktop-power-source.ts'
import { NS } from './locales.ts'
import css from './WechatSettings.module.css'

/** Data and commands supplied by the client registration. */
export interface WechatSettingsInjected {
  readonly hooks: {
    readonly snapshot: HostObservable<WechatSnapshot>
    readonly power: WechatDesktopPowerSource['store']
  }
  /** Whether a protocol-compatible Desktop power bridge is available. */
  readonly powerAvailable: boolean
  /** @param preventSleep - Whether to prevent system suspension while Desktop runs. */
  setPreventSleep(preventSleep: boolean): Promise<void>
  startLogin(): Promise<void>
  cancelLogin(): Promise<void>
  disconnect(): Promise<void>
  reconnect(): Promise<void>
  logout(): Promise<void>
  setDefaultProject(path: string): Promise<void>
}

export type WechatSettingsProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & InjectFace<WechatSettingsInjected>

/** Render the QR login lifecycle and project selection. */
export function WechatSettings(props: WechatSettingsProps) {
  const snapshot = props.useSnapshot(value => value)
  const power = props.usePower(value => value)
  const { t } = props
  const status = snapshot.status
  const connected = status.state === 'connected'
  const waiting = status.state === 'qr-pending'
  const label = status.state === 'idle' && snapshot.hasCredentials ? t('disconnected')
    : status.state === 'scanned' ? t('scanned')
      : status.state === 'connecting' ? t('connecting')
        : status.state === 'reconnecting' ? t('reconnecting')
          : status.state === 'logged-out' ? t('loggedOut')
            : t('waiting')

  return <section className={css.section} aria-labelledby="wechat-settings-title">
    <h2 className={css.title} id="wechat-settings-title">{t(connected ? 'connected' : 'title')}</h2>
    {!connected && <p className={css.intro}>{t('description')}</p>}
    {waiting && <div className={css.qr}>
      <img src={status.qrDataUrl} alt={t('waiting')} />
      <p className={css.status} role="status">{label}</p>
    </div>}
    {!waiting && !connected && (snapshot.hasCredentials || status.state !== 'idle' && status.state !== 'logged-out')
      && <p className={css.status} role="status">{label}</p>}
    {snapshot.error && <p role="status" className={css.error}>{snapshot.error}</p>}
    {connected && <p className={css.connected}><span aria-hidden="true" />{t('connectedState')}</p>}
    <div className={css.actions}>
      {!snapshot.hasCredentials && !connected && (status.state === 'idle' || status.state === 'logged-out')
        && <Button variant="primary" onClick={() => { void props.startLogin() }}>{t('add')}</Button>}
      {waiting && <Button variant="outline" onClick={() => { void props.cancelLogin() }}>{t('cancel')}</Button>}
      {snapshot.hasCredentials && <>
        {connected && <Button variant="outline" onClick={() => { void props.disconnect() }}>{t('disconnect')}</Button>}
        <Button variant="outline" onClick={() => { void props.reconnect() }}>{t('reconnect')}</Button>
        <Button variant="outline" onClick={() => {
          if (window.confirm(t('confirmLogout')) && window.confirm(t('confirmLogoutAgain'))) void props.logout()
        }}>{t('logout')}</Button>
      </>}
    </div>
    {props.powerAvailable && <div className={css.power} role="group" aria-label={t('keepAwake.title')}>
      <div className={css.powerText}>
        <div className={css.powerTitle}>{t('keepAwake.title')}</div>
        <div className={css.powerDescription}>{t('keepAwake.description')}</div>
        {power.failed && <div className={css.error} role="alert">{t('keepAwake.error')}</div>}
      </div>
      <Switch checked={power.pending ?? power.state?.preventSleep ?? false}
        disabled={power.pending !== undefined || power.state?.changing === true || power.state === undefined}
        label={t('keepAwake.title')} onChange={(value) => { void props.setPreventSleep(value) }} />
    </div>}
    {connected && <div className={css.project}>
      <label htmlFor="wechat-project">{t('project')}</label>
      <select id="wechat-project" value={snapshot.defaultProjectPath ?? ''}
        onChange={(event) => { void props.setDefaultProject(event.target.value) }}>
        {snapshot.projects.map(project => <option key={project.path} value={project.path}>{project.title}</option>)}
        {snapshot.projects.length === 0 && <option value="">{t('noProjects')}</option>}
      </select>
      <p className={css.projectHint}>{t('projectHint')}</p>
    </div>}
    {connected && <div className={css.usage}>
      <p>{t('usage')}</p>
      <h3>{t('commands')}</h3>
      <ul>
        <li>{t('commandNew')}</li><li>{t('commandList')}</li><li>{t('commandUse')}</li>
        <li>{t('commandProject')}</li><li>{t('commandCancel')}</li><li>{t('commandHelp')}</li>
      </ul>
    </div>}
  </section>
}
