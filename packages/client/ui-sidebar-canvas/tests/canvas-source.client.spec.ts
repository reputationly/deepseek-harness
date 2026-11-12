/** The canvas source publishes the latest read, keeps a shown document through failures, and reports edits that did not apply. */
import { expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { CanvasEditResult, CanvasView } from '@deepseek-ai/dsh-canvas/client'
import { CanvasSource } from '../src/client/canvas-source.ts'

const view = (directory: string, nextId = 1): CanvasView => ({
  directory,
  episode: { id: 'e1' as never, title: 'Canvas' },
  revisions: { canvas: 3 },
  document: { version: 2, revision: 3, nextId, nodes: [], edges: [] },
})
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const failure = (message: string): RemoteResult<never> => ({ ok: false, error: { code: 'internal', message } as never })
const applied: CanvasEditResult = { revision: 3, refs: {}, created: [], skipped: [] }

it('shows the document it read and keeps it visible when a later read fails', async () => {
  const get = vi.fn<() => Promise<RemoteResult<CanvasView>>>().mockResolvedValueOnce(ok(view('/project')))
  const source = new CanvasSource({ get, apply: vi.fn() })
  expect(source.state.getSnapshot()).toEqual({ status: 'loading', view: undefined, error: undefined, notice: undefined })

  await source.load()
  expect(source.state.getSnapshot()).toEqual({ status: 'ready', view: view('/project'), error: undefined, notice: undefined })

  get.mockResolvedValueOnce(failure('canvas file is corrupt'))
  await source.load()
  expect(source.state.getSnapshot()).toEqual({ status: 'failed', view: view('/project'), error: 'canvas file is corrupt', notice: undefined })

  get.mockResolvedValueOnce(ok(view('/project', 2)))
  await source.load()
  expect(source.state.getSnapshot()).toMatchObject({ status: 'ready', error: undefined, view: view('/project', 2) })
})

it('lets only the latest read publish', async () => {
  let finishFirst!: (value: RemoteResult<CanvasView>) => void
  const get = vi.fn<() => Promise<RemoteResult<CanvasView>>>()
    .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve }))
    .mockResolvedValueOnce(ok(view('/project', 5)))
  const source = new CanvasSource({ get, apply: vi.fn() })
  const first = source.load()
  await source.load()
  finishFirst(ok(view('/project', 1)))
  await first
  expect(source.state.getSnapshot().view).toEqual(view('/project', 5))
})

it('applies edits in one call, reads the settled document, and reports what did not apply until dismissed', async () => {
  const get = vi.fn<() => Promise<RemoteResult<CanvasView>>>().mockResolvedValue(ok(view('/project')))
  const apply = vi.fn<(operations: unknown[], baseRevision: number) => Promise<RemoteResult<CanvasEditResult>>>()
    .mockResolvedValue(ok(applied))
  const source = new CanvasSource({ get, apply })

  await source.load()
  await source.edit([])
  expect(apply).not.toHaveBeenCalled()
  expect(get).toHaveBeenCalledOnce()

  await source.edit([{ op: 'remove', node: 'n1' }])
  expect(apply).toHaveBeenCalledWith([{ op: 'remove', node: 'n1' }], 3)
  expect(get).toHaveBeenCalledTimes(2)
  expect(source.state.getSnapshot().notice).toBeUndefined()

  apply.mockResolvedValueOnce(ok({ ...applied, skipped: [{ index: 0, op: 'connect', reason: 'the edge would form a cycle' }] }))
  await source.edit([{ op: 'connect', from: 'n2', to: 'n1' }])
  expect(source.state.getSnapshot().notice).toBe('the edge would form a cycle')

  apply.mockResolvedValueOnce(failure('canvas file is corrupt'))
  await source.edit([{ op: 'remove', node: 'n1' }])
  expect(source.state.getSnapshot()).toMatchObject({ status: 'ready', notice: 'canvas file is corrupt' })

  source.dismiss()
  expect(source.state.getSnapshot().notice).toBeUndefined()
})

it('reads again when the shown project changes and ignores other projects', async () => {
  const get = vi.fn<() => Promise<RemoteResult<CanvasView>>>().mockResolvedValue(ok(view('/project')))
  const source = new CanvasSource({ get, apply: vi.fn() })
  source.changed('/project')
  expect(get).not.toHaveBeenCalled()
  await source.load()
  source.changed('/other')
  expect(get).toHaveBeenCalledOnce()
  source.changed('/project')
  expect(get).toHaveBeenCalledTimes(2)
})

it('forgets the document on a replaced connection and stops publishing once disposed', async () => {
  let finish!: (value: RemoteResult<CanvasView>) => void
  const get = vi.fn<() => Promise<RemoteResult<CanvasView>>>().mockResolvedValueOnce(ok(view('/project')))
  const source = new CanvasSource({ get, apply: vi.fn() })
  await source.load()

  get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  source.reset()
  expect(source.state.getSnapshot()).toEqual({ status: 'loading', view: undefined, error: undefined, notice: undefined })

  source.dispose()
  finish(ok(view('/project', 9)))
  await Promise.resolve()
  expect(source.state.getSnapshot().view).toBeUndefined()
})
