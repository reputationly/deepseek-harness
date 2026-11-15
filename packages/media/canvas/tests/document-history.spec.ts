/** A failed live write cannot remove revisions promised by the preceding committed window. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { CanvasStore } from '../src/store.ts'
import { parseTimeline } from '../src/timeline.ts'
import type { Timeline } from '../src/timeline-types.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async (original) => {
  const actual = await original<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})
let directory: string
let store: CanvasStore
const file = 'canvas.json.timelines/n1.json'
const initial: Timeline = { version: 1, revision: 0, spec: { width: 720, height: 1280, fps: 24 }, tracks: [] }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-timeline-history-'))
  store = new CanvasStore()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})
const write = () =>
  store.updateDocument(
    directory,
    file,
    parseTimeline,
    () => initial,
    current => ({ document: current, value: undefined }),
    2,
  )
const history = () =>
  store.updateCanvas(directory, 'canvas.json', async () => ({
    value: await store.documentHistory(directory, file, parseTimeline, 2),
  }))

it('keeps the old history window on failure and reuses the immutable predecessor on retry', async () => {
  await write()
  await write()
  await write()
  const before = await readFile(join(directory, '.canvas', file), 'utf8')
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-atomic-write')>('@deepseek-ai/dsh-atomic-write')
  vi.mocked(writeFileAtomic)
    .mockImplementationOnce(actual.writeFileAtomic)
    .mockRejectedValueOnce(new Error('controlled main write failure'))
  await expect(write()).rejects.toThrow('controlled main write failure')
  expect(await readFile(join(directory, '.canvas', file), 'utf8')).toBe(before)
  expect((await history()).map(document => document.revision)).toEqual([3, 2, 1])
  const predecessor = await readFile(join(directory, '.canvas', `${file}.history/3.json`), 'utf8')
  await write()
  expect((await history()).map(document => document.revision)).toEqual([4, 3, 2])
  expect(await readFile(join(directory, '.canvas', `${file}.history/3.json`), 'utf8')).toBe(predecessor)
})
