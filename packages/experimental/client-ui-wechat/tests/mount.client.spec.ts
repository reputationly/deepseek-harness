import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { WechatSnapshot, WechatStatus } from '@deepseek-ai/dsh-wechat/types'
import { inject, apply } from '../src/client/index.ts'
import { WechatSettings } from '../src/client/WechatSettings.tsx'
import { WechatSettingsIcon } from '../src/client/WechatSettingsIcon.tsx'
import type { WechatPowerState } from '../src/client/desktop-power-source.ts'
import type { WechatSettingsInjected } from '../src/client/WechatSettings.tsx'

const snapshot: WechatSnapshot = {
  status: { state: 'idle' },
  hasCredentials: false,
  projects: [{ id: 'project-1', title: 'Default', path: '/workspace/default' }],
}

it('mounts the generated Remote, status stream, localized settings slot and disposers', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const unmountRemote = vi.fn(async () => {})
  const streamDispose = vi.fn()
  const unsubscribePower = vi.fn()
  let powerListener: ((state: WechatPowerState) => void) | undefined
  const calls: string[] = []
  const powerSet = vi.fn(async (preventSleep: boolean) => ({
    kind: 'applied' as const, state: { preventSleep, changing: false },
  }))
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, power: {
    get: async (): Promise<WechatPowerState> => ({ preventSleep: false, changing: false }),
    set: powerSet,
    subscribe(listener: (state: WechatPowerState) => void) {
      powerListener = listener
      return unsubscribePower
    },
  } })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-wechat', descriptors: [] }
  class TestRemote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(value: TypertRemoteContribution) {
      expect(value.package).toBe(contribution.package)
      calls.push('$mount')
      return unmountRemote
    }
  }
  new TestRemote()
  const connected: WechatStatus = { state: 'connected', botId: 'bot…id' }
  const stream = Object.assign((async function* () { yield connected })(), { dispose: streamDispose })
  const operation = vi.fn(async (): Promise<{ ok: true; value: WechatSnapshot }> => ({ ok: true, value: snapshot }))
  ctx.provide('remote.wechat', {
    getStatus: operation,
    startLogin: operation,
    cancelLogin: operation,
    disconnect: operation,
    reconnect: operation,
    logout: operation,
    setDefaultProject: operation,
    watchStatus: () => stream,
  } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'settings.section.icon': { kind: 'list', scope: 'root', inline: true },
  } } as never, () => null)

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  const entry = ctx.slots.entries('settings.section').find(item => item.options.id === 'wechat')
  const iconEntry = ctx.slots.entries('settings.section.icon').find(item => item.options.id === 'wechat')
  expect(entry).toMatchObject({ locale: 'wechat', options: { id: 'wechat' } })
  expect(entry?.component).toBe(WechatSettings)
  expect(iconEntry?.component).toBe(WechatSettingsIcon)
  expect(operation).toHaveBeenCalledOnce()
  expect(typeof ctx.locale.bind('wechat')('title')).toBe('string')
  const injected = entry?.inject?.()
  const powerAvailable = injected?.powerAvailable
  const setPreventSleep = injected?.setPreventSleep as WechatSettingsInjected['setPreventSleep']
  const powerHooks = injected?.hooks as WechatSettingsInjected['hooks']
  expect(powerAvailable).toBe(true)
  await setPreventSleep(true)
  expect(powerSet).toHaveBeenCalledWith(true)
  expect(powerHooks.power.getSnapshot().state).toEqual({ preventSleep: true, changing: false })
  powerListener?.({ preventSleep: false, changing: false })
  expect(powerHooks.power.getSnapshot().state).toEqual({ preventSleep: false, changing: false })

  await fiber.dispose()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(ctx.slots.entries('settings.section.icon')).toHaveLength(0)
  expect(streamDispose).toHaveBeenCalledOnce()
  expect(unsubscribePower).toHaveBeenCalledOnce()
  expect(unmountRemote).toHaveBeenCalledOnce()
  expect(calls).toEqual(['$mount'])
})
