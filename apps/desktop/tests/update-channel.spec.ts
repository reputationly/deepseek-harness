import { describe, expect, it } from 'vitest'
import { desktopManualUpdate, desktopUpdateChannel } from '../src/update-channel.ts'

it('reads the installed channel independently from the current version', () => {
  expect(desktopUpdateChannel({ version: '1.0.0', dshDesktopUpdateChannel: 'nightly' })).toBe('nightly')
  expect(desktopUpdateChannel({ version: '1.0.0', dshDesktopUpdateChannel: 'stable' })).toBe('stable')
  expect(desktopUpdateChannel({ version: '1.0.0' })).toBe('nightly')
  expect(() => desktopUpdateChannel({ dshDesktopUpdateChannel: 'latest' })).toThrow(/channel/u)
  expect(() => desktopUpdateChannel({ dshDesktopUpdateChannel: 'beta' })).toThrow(/channel/u)
  expect(() => desktopUpdateChannel(null)).toThrow(/manifest/u)
})

describe('desktop manual installer flag', () => {
  it('reads the sealed handoff flag and defaults to in-place updates', () => {
    expect(desktopManualUpdate({ dshDesktopManualUpdate: true })).toBe(true)
    expect(desktopManualUpdate({ dshDesktopManualUpdate: false })).toBe(false)
    expect(desktopManualUpdate({ dshDesktopUpdateChannel: 'nightly' })).toBe(false)
    expect(() => desktopManualUpdate(null)).toThrow(/invalid application manifest/u)
  })
})
