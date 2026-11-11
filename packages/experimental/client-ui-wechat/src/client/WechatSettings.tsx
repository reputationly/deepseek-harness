import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WechatSnapshot } from '@deepseek-ai/dsh-wechat/types'
import { NS } from './locales.ts'
import css from './WechatSettings.module.css'

/** Data and commands supplied by the client registration. */
export interface WechatSettingsInjected {
  readonly hooks: { readonly snapshot: HostObservable<WechatSnapshot> }
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

  return <section className={css.card} aria-labelledby="wechat-settings-title">
    <h2 id="wechat-settings-title">{t(connected ? 'connected' : 'title')}</h2>
    {!connected && <p className={css.description}>{t('description')}</p>}
    {waiting && <div className={css.qr}>
      <img src={status.qrDataUrl} alt={t('waiting')} />
      <p role="status">{label}</p>
    </div>}
    {!waiting && !connected && (snapshot.hasCredentials || status.state !== 'idle' && status.state !== 'logged-out')
      && <p role="status">{label}</p>}
    {snapshot.error && <p role="status" className={css.error}>{snapshot.error}</p>}
    {connected && <p className={css.connected}><span aria-hidden="true" />{t('connectedState')}</p>}
    {!snapshot.hasCredentials && !connected && (status.state === 'idle' || status.state === 'logged-out') && <Button onClick={() => { void props.startLogin() }}>
      {t('add')}
    </Button>}
    {waiting && <Button variant="outline" onClick={() => { void props.cancelLogin() }}>{t('cancel')}</Button>}
    {snapshot.hasCredentials && <div className={css.actions}>
      {connected && <Button variant="outline" onClick={() => { void props.disconnect() }}>{t('disconnect')}</Button>}
      <Button variant="outline" onClick={() => { void props.reconnect() }}>{t('reconnect')}</Button>
      <Button variant="outline" onClick={() => {
        if (window.confirm(t('confirmLogout')) && window.confirm(t('confirmLogoutAgain'))) void props.logout()
      }}>{t('logout')}</Button>
    </div>}
    {connected && <div className={css.project}>
      <label htmlFor="wechat-project">{t('project')}</label>
      <select id="wechat-project" value={snapshot.defaultProjectPath ?? ''}
        onChange={(event) => { void props.setDefaultProject(event.target.value) }}>
        {snapshot.projects.map(project => <option key={project.path} value={project.path}>{project.title}</option>)}
        {snapshot.projects.length === 0 && <option value="">{t('noProjects')}</option>}
      </select>
      <p>{t('projectHint')}</p>
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
