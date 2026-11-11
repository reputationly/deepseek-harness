import { expect, it, vi } from 'vitest'
import type { PowerSaveBlocker } from 'electron'
import { DesktopKeepAwake } from '../src/keep-awake.ts'

function fixture() {
  let started = false
  const blocker: Pick<PowerSaveBlocker, 'start' | 'stop' | 'isStarted'> = {
    start: vi.fn(() => { started = true; return 1 }),
    stop: vi.fn(() => { started = false; return true }),
    isStarted: vi.fn(() => started),
  }
  return { blocker, keepAwake: new DesktopKeepAwake(blocker) }
}

it('starts once and stops the blocker on disable', () => {
  const { blocker, keepAwake } = fixture()
  keepAwake.set(true)
  keepAwake.set(true)
  expect(blocker.start).toHaveBeenCalledExactlyOnceWith('prevent-app-suspension')
  expect(keepAwake.active).toBe(true)
  keepAwake.set(false)
  keepAwake.set(false)
  expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(1)
  expect(keepAwake.active).toBe(false)
})

it('stops the blocker on disposal and remains idempotent', () => {
  const { blocker, keepAwake } = fixture()
  keepAwake.set(true)
  keepAwake.dispose()
  keepAwake.dispose()
  expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(1)
  expect(keepAwake.active).toBe(false)
})
