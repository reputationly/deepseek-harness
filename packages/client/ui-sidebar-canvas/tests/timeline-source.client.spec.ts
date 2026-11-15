import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { CanvasNodeId, EpisodeId, Timeline, TimelineEditResult, TimelineOperation } from '@deepseek-ai/dsh-canvas/client'
import { TimelineSource, type TimelinePort } from '../src/client/timeline-source.ts'

const node = brandString<CanvasNodeId>('n1')
const binding = { directory: '/project', episode: brandString<EpisodeId>('e1') }
const spec = { width: 1280, height: 720, fps: 24 } as const
const document = (revision: number): Timeline => ({ version: 1, revision, spec, tracks: [] })
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const operations: TimelineOperation[] = [{ op: 'set_spec', spec: { ...spec, fps: 30 } }]
function fixture() {
  const port: TimelinePort = {
    get: vi.fn(async () => ok(document(1))),
    edit: vi.fn(async () => ok({ document: document(2), invalidated: [] })),
    history: vi.fn(async () => ok([])), restore: vi.fn(async () => ok({ document: document(3), invalidated: [] })),
    status: vi.fn(async () => ok({ revision: 1, state: 'stale' as const, progress: 0 })),
    start: vi.fn(async () => ok({ revision: 1, state: 'queued' as const, progress: 0 })),
    cancel: vi.fn(async () => ok(true)), clear: vi.fn(async () => ok(undefined)),
    export: vi.fn(async () => ok({ node: brandString<CanvasNodeId>('n2'), path: '/project/output.mp4', revision: 1 })),
    report: vi.fn(),
  }
  return { port, source: new TimelineSource(port) }
}
it('addresses every write to the captured project and episode with the form revision', async () => {
  const { port, source } = fixture()
  await source.open(node, binding)
  await source.edit(operations, 1)
  expect(port.get).toHaveBeenCalledWith(node, binding)
  expect(port.edit).toHaveBeenCalledExactlyOnceWith(node, operations, 1, undefined, binding)
  expect(source.state.getSnapshot()).toMatchObject({ trusted: true, working: false, document: { revision: 2 }, render: { state: 'stale' } })
})
it('keeps conflicting commands through reload and merges only on a separate user gesture', async () => {
  const { port, source } = fixture()
  await source.open(node, binding)
  vi.mocked(port.edit).mockResolvedValueOnce({ ok: false, error: new RemoteError('canvas/conflict', 'revision changed', { expected: 1, actual: 2 }) })
  vi.mocked(port.get).mockResolvedValue(ok(document(2)))
  expect(await source.edit(operations, 1)).toBe(false)
  expect(source.state.getSnapshot()).toMatchObject({ document: { revision: 2 }, notice: { kind: 'conflict' }, pending: operations })
  expect(port.edit).toHaveBeenCalledTimes(1)
  vi.mocked(port.edit).mockResolvedValueOnce(ok({ document: document(3), invalidated: [] }))
  expect(await source.merge()).toBe(true)
  expect(port.edit).toHaveBeenLastCalledWith(node, operations, 2, undefined, binding)
  expect(source.state.getSnapshot()).toMatchObject({ document: { revision: 3 }, pending: [], notice: undefined })
})
it('does not regress to a read that started before a successful write', async () => {
  const { port, source } = fixture()
  await source.open(node, binding)
  const old = Promise.withResolvers<RemoteResult<Timeline | undefined>>()
  vi.mocked(port.get).mockReturnValueOnce(old.promise)
  const read = source.load()
  await source.edit(operations, 1)
  old.resolve(ok(document(1)))
  await read
  expect(source.state.getSnapshot()).toMatchObject({ document: { revision: 2 }, loading: false })
})
it('fences reads and writes when selecting the same node id in another episode', async () => {
  const { port, source } = fixture()
  await source.open(node, binding)
  const old = Promise.withResolvers<RemoteResult<Timeline | undefined>>()
  vi.mocked(port.get).mockReturnValueOnce(old.promise)
  const read = source.load()
  const next = { ...binding, episode: brandString<EpisodeId>('e2') }
  vi.mocked(port.get).mockResolvedValue(ok(document(5)))
  await source.open(node, next)
  old.resolve(ok(document(1)))
  await read
  expect(source.state.getSnapshot()).toMatchObject({ binding: next, document: { revision: 5 } })
  await source.edit(operations, 5)
  expect(port.edit).toHaveBeenLastCalledWith(node, operations, 5, undefined, next)
})
it('keeps the shown document and rejected draft while hiding preview after an unreadable response', async () => {
  const { port, source } = fixture()
  await source.open(node, binding)
  vi.mocked(port.edit).mockResolvedValueOnce({ ok: false, error: new RemoteError('canvas/conflict', 'revision changed', { expected: 1, actual: 2 }) })
  vi.mocked(port.get).mockRejectedValue(new Error('connection assembly failed'))
  await source.edit(operations, 1)
  expect(source.state.getSnapshot()).toMatchObject({ trusted: false, document: { revision: 1 }, pending: operations, render: undefined, notice: { kind: 'read' } })
  vi.mocked(port.get).mockResolvedValue(ok(document(2)))
  await source.load()
  expect(source.state.getSnapshot()).toMatchObject({ trusted: true, document: { revision: 2 }, pending: operations, notice: undefined })
})
it('marks an interrupted write outcome unknown and joins it before disposal without publishing late data', async () => {
  const { port, source } = fixture()
  await source.open(node, binding)
  vi.mocked(port.edit).mockRejectedValueOnce(new Error('connection replaced'))
  expect(await source.edit(operations, 1)).toBe(false)
  expect(source.state.getSnapshot()).toMatchObject({ trusted: false, pending: operations, notice: { kind: 'unknown' } })
  expect(port.report).toHaveBeenCalledOnce()
  const pending = Promise.withResolvers<RemoteResult<{ node: CanvasNodeId; path: string; revision: number }>>()
  vi.mocked(port.export).mockReturnValueOnce(pending.promise)
  const exporting = source.export()
  let closed = false
  const close = source.dispose().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  pending.resolve(ok({ node, path: '/project/output.mp4', revision: 1 }))
  await exporting; await close
  expect(source.state.getSnapshot().exported).toBeUndefined()
})
it('does not present an unavailable renderer as ready', async () => {
  const { port, source } = fixture()
  vi.mocked(port.status).mockResolvedValue(undefined)
  vi.mocked(port.start).mockResolvedValue(undefined)
  await source.open(node, binding)
  expect(source.state.getSnapshot()).toMatchObject({ available: false, trusted: true, render: undefined })
  await source.render()
  expect(source.state.getSnapshot()).toMatchObject({ notice: { kind: 'unavailable' }, render: undefined })
})

it('does not replace a later Agent revision when an earlier manual reply arrives last', async () => {
  const { port, source } = fixture()
  await source.open(node, binding)
  const reply = Promise.withResolvers<RemoteResult<TimelineEditResult>>()
  vi.mocked(port.edit).mockReturnValueOnce(reply.promise)
  const editing = source.edit(operations, 1)
  await vi.waitFor(() => { expect(port.edit).toHaveBeenCalledOnce() })
  vi.mocked(port.get).mockResolvedValue(ok(document(3)))
  await source.load()
  reply.resolve(ok({ document: document(2), invalidated: [] }))
  expect(await editing).toBe(true)
  expect(source.state.getSnapshot()).toMatchObject({ document: { revision: 3 }, working: false, pending: [] })
})

it('retains rejected commands separately for the same node id in different episodes', async () => {
  const { port, source } = fixture()
  await source.open(node, binding)
  vi.mocked(port.edit).mockResolvedValueOnce({ ok: false, error: new RemoteError('canvas/conflict', 'changed', { expected: 1, actual: 2 }) })
  await source.edit(operations, 1)
  await source.open(node, { ...binding, episode: brandString<EpisodeId>('e2') })
  expect(source.state.getSnapshot().pending).toEqual([])
  await source.open(node, binding)
  expect(source.state.getSnapshot()).toMatchObject({ binding, pending: operations, notice: { kind: 'conflict' } })
})

it('reports an unconfirmed restore after connection replacement instead of presenting the late reply as saved', async () => {
  const { port, source } = fixture()
  vi.mocked(port.get).mockResolvedValue(ok(document(2)))
  await source.open(node, binding)
  const reply = Promise.withResolvers<RemoteResult<TimelineEditResult>>()
  vi.mocked(port.restore).mockReturnValueOnce(reply.promise)
  const restoring = source.restore(1, 2, 'restore')
  await vi.waitFor(() => { expect(port.restore).toHaveBeenCalledOnce() })
  source.reset()
  await source.load()
  reply.resolve(ok({ document: document(3), invalidated: [] }))
  expect(await restoring).toBe(false)
  expect(source.state.getSnapshot()).toMatchObject({ document: { revision: 2 }, notice: { kind: 'unknown' }, pending: [] })
})
