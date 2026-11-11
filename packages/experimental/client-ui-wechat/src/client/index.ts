import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-wechat/remote'
import wechatRemote from '@deepseek-ai/dsh-wechat/remote'
import type { WechatSnapshot } from '@deepseek-ai/dsh-wechat/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { NS, de, en, es, fr, ja, pt, ru, zh } from './locales.ts'
import { WechatSettings } from './WechatSettings.tsx'
import { WechatSettingsIcon } from './WechatSettingsIcon.tsx'
import type { WechatSettingsInjected } from './WechatSettings.tsx'
import { WechatDesktopPowerSource, type WechatPowerBridge } from './desktop-power-source.ts'
import { inject, mountWechat } from './mount.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { wechat: import('./locales.ts').WechatLocaleKey }
}

export { inject }

/** Mount WeChat's generated Remote and settings section. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountWechat(ctx, wechatRemote, registerUi)
}

async function registerUi(ctx: Context): Promise<void> {
  const status = createSnapshotStore<WechatSnapshot>({
    status: { state: 'idle' },
    hasCredentials: false,
    projects: [],
  })
  const update = async (operation: () => Promise<RemoteResult<WechatSnapshot>>): Promise<void> => {
    try {
      const result = await operation()
      if (result.ok) status.set(result.value)
      else ctx.logger.warn('wechat-settings: Host request failed')
    } catch {
      ctx.logger.warn('wechat-settings: Host request failed')
    }
  }
  const initial = await ctx.remote.wechat.getStatus()
  if (initial.ok) status.set(initial.value)
  ctx.effect(() => {
    const watch = ctx.remote.wechat.watchStatus()
    const watching = (async () => {
      try {
        for await (const next of watch) {
          if (ctx.fiber.uid === null) return
          const current = status.getSnapshot()
          status.set({
            status: next,
            hasCredentials: next.state === 'logged-out' ? false
              : next.state === 'connected' || next.state === 'reconnecting' ? true
                : current.hasCredentials,
            projects: current.projects,
            ...(current.defaultProjectPath === undefined ? {} : { defaultProjectPath: current.defaultProjectPath }),
            ...(next.state === 'reconnecting' ? { error: next.lastError } : {}),
          })
        }
      } catch {
        if (ctx.fiber.uid !== null) ctx.logger.warn('wechat-settings: status stream ended')
      }
    })()
    return async () => {
      watch.dispose()
      await watching
    }
  }, 'wechat-settings: status stream')
  const desktop = (globalThis as typeof globalThis & { dshDesktop?: {
    protocolVersion: number
    power?: WechatPowerBridge
  } }).dshDesktop
  const powerBridge = desktop?.protocolVersion === 1 ? desktop.power : undefined
  const power = new WechatDesktopPowerSource(powerBridge)
  ctx.effect(() => () => { power.dispose() }, 'wechat settings: Desktop power')
  ctx.effect(() => ctx.locale.register(NS, { de, en, es, fr, ja, pt, ru, zh }))
  const injected: WechatSettingsInjected = {
    hooks: { snapshot: status, power: power.store },
    powerAvailable: powerBridge !== undefined,
    setPreventSleep: value => power.setPreventSleep(value),
    startLogin: async () =>{  await update(() => ctx.remote.wechat.startLogin()) },
    cancelLogin: async () =>{  await update(() => ctx.remote.wechat.cancelLogin()) },
    disconnect: async () =>{  await update(() => ctx.remote.wechat.disconnect()) },
    reconnect: async () =>{  await update(() => ctx.remote.wechat.reconnect()) },
    logout: async () =>{  await update(() => ctx.remote.wechat.logout()) },
    setDefaultProject: async (path) =>{  await update(() => ctx.remote.wechat.setDefaultProject(path)) },
  }
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'wechat',
    order: 40,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: () => injected,
  }, WechatSettings)))
  ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: 'wechat',
    order: 40,
  }, WechatSettingsIcon)))
}
