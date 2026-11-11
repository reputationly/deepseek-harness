// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { WechatSnapshot } from '@deepseek-ai/dsh-wechat/types'
import { WechatDesktopPowerSource, type WechatPowerState } from '../src/client/desktop-power-source.ts'
import { WechatSettings } from '../src/client/WechatSettings.tsx'
import type { WechatSettingsProps } from '../src/client/WechatSettings.tsx'
import { en } from '../src/client/locales.ts'

it('reverts the WeChat keep-awake switch and displays the localized save error', async () => {
  const accepted: WechatPowerState = { preventSleep: false, changing: false }
  const set = vi.fn(async () => ({ kind: 'failed' as const, state: accepted }))
  const source = new WechatDesktopPowerSource({
    get: async () => accepted,
    set,
    subscribe: () => () => {},
  })
  const snapshot: WechatSnapshot = { status: { state: 'idle' }, hasCredentials: false, projects: [] }
  const props = {
    useSnapshot: (select: (value: WechatSnapshot) => unknown) => select(snapshot),
    usePower: (select: (value: ReturnType<typeof source.store.getSnapshot>) => unknown) =>
      select(source.store.getSnapshot()),
    powerAvailable: true,
    setPreventSleep: (value: boolean) => source.setPreventSleep(value),
    startLogin: async () => {},
    cancelLogin: async () => {},
    disconnect: async () => {},
    reconnect: async () => {},
    logout: async () => {},
    setDefaultProject: async (_path: string) => {},
    t: (key: keyof typeof en) => en[key],
  } as WechatSettingsProps

  const view = render(<WechatSettings {...props} />)
  await waitFor(() => { expect(source.store.getSnapshot().state).toEqual(accepted) })
  view.rerender(<WechatSettings {...props} />)
  const toggle = screen.getByRole('switch', { name: en['keepAwake.title'] })
  expect(toggle.hasAttribute('disabled')).toBe(false)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  await waitFor(() => { expect(source.store.getSnapshot().failed).toBe(true) })
  view.rerender(<WechatSettings {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(en['keepAwake.error'])
  expect(screen.getByRole('switch', { name: en['keepAwake.title'] }).getAttribute('aria-checked')).toBe('false')
  expect(set).toHaveBeenCalledExactlyOnceWith(true)
  view.unmount()
  source.dispose()
})
