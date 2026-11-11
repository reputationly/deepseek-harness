import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { WechatSnapshot, WechatStatus } from '@deepseek-ai/dsh-wechat/types'
import { inject, apply } from '../src/client/index.ts'
import { WechatSettings } from '../src/client/WechatSettings.tsx'
import { WechatSettingsIcon } from '../src/client/WechatSettingsIcon.tsx'

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
  const calls: string[] = []
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

  await fiber.dispose()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(ctx.slots.entries('settings.section.icon')).toHaveLength(0)
  expect(streamDispose).toHaveBeenCalledOnce()
  expect(unmountRemote).toHaveBeenCalledOnce()
  expect(calls).toEqual(['$mount'])
})
