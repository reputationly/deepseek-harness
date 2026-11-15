/** Exercise CanvasStore through real atomic replacement, with controlled Windows sharing errors. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CanvasStore, canvasFile } from '../src/store.ts'

const sharing = vi.hoisted(() => ({ errors: [] as string[], attempts: 0 }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    sharing.attempts += 1
    const code = sharing.errors.shift()
    if (code !== undefined) throw Object.assign(new Error(`${code}: controlled sharing violation`), { code })
    return actual.rename(...args)
  } }
})

let directory: string
let store: CanvasStore
let pending: Promise<unknown>[]

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-atomic-'))
  store = new CanvasStore()
  pending = []
  sharing.errors = []
  sharing.attempts = 0
})

afterEach(async () => {
  if (vi.isFakeTimers()) await vi.runAllTimersAsync()
  vi.useRealTimers()
  await Promise.allSettled(pending)
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function rewrite(): Promise<void> {
  const work = store.updateCanvas(directory, 'canvas.json', current => ({
    document: { ...current, revision: current.revision + 1 }, value: undefined,
  }))
  pending.push(work)
  void work.catch(() => undefined) // The assertion observes failure; cleanup also awaits settlement.
  return work
}

it('keeps the old readable revision until a transient Windows replacement commits', async () => {
  await rewrite()
  const before = await readFile(canvasFile(directory), 'utf8')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.useFakeTimers()
  sharing.attempts = 0
  sharing.errors = ['EACCES', 'EBUSY', 'EPERM']
  const work = rewrite()
  await vi.waitFor(() => { expect(sharing.attempts).toBeGreaterThan(0) })
  expect(await readFile(canvasFile(directory), 'utf8')).toBe(before)
  await vi.runAllTimersAsync()
  await work
  expect(sharing.attempts).toBe(4)
  expect((await store.readCanvas(directory)).revision).toBe(2)
  expect((await readdir(join(directory, '.canvas'))).filter(file => file.endsWith('.tmp'))).toEqual([])
})

it('preserves bytes on a permanent sharing failure and permits a valid retry after cleanup', async () => {
  await rewrite()
  const before = await readFile(canvasFile(directory), 'utf8')
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.useFakeTimers()
  sharing.attempts = 0
  sharing.errors = Array.from({ length: 9 }, () => 'EPERM')
  const rejected = rewrite().then(() => undefined, (error: unknown) => error)
  await vi.waitFor(() => { expect(sharing.attempts).toBeGreaterThan(0) })
  await vi.runAllTimersAsync()
  expect(await rejected).toMatchObject({ code: 'EPERM' })
  expect(sharing.attempts).toBe(9)
  expect(await readFile(canvasFile(directory), 'utf8')).toBe(before)
  expect((await readdir(join(directory, '.canvas'))).filter(file => file.endsWith('.tmp'))).toEqual([])
  await rewrite()
  expect((await store.readCanvas(directory)).revision).toBe(2)
})
