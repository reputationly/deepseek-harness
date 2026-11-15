/** Plugin-owned work is serialized, fenced on reset, and joined on disposal. */
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasNodeId, EpisodeId } from '@deepseek-ai/dsh-canvas/client'
import type { TimelineRenderNotice, TimelineRenderWork } from '@deepseek-ai/dsh-api-remotes/client'
import { TimelineWorker, type TimelineWorkerPort } from '../src/client/timeline-worker.ts'
import { TimelineRenderFailure } from '../src/client/timeline-failure.ts'

const render = vi.hoisted(() => vi.fn<(...args: readonly unknown[]) => Promise<void>>())
vi.mock('../src/client/timeline-renderer.ts', () => ({ renderTimeline: render }))
const session = brandString<SessionId>('s1')
type Job = TimelineRenderWork['jobId']
const job = (id: string): Job => brandString<Job>(id)
function work(id: Job): TimelineRenderWork {
  return {
    jobId: id,
    lease: brandString<TimelineRenderWork['lease']>('lease'),
    plan: {
      version: 1,
      key: brandString<TimelineRenderWork['plan']['key']>('b'.repeat(64)),
      node: brandString<CanvasNodeId>('n1'),
      episode: brandString<EpisodeId>('e1'),
      document: { version: 1, revision: 1, spec: { width: 16, height: 16, fps: 24 }, tracks: [] },
      assets: [],
      style: {
        background: '#000000',
        fontFamily: 'sans-serif',
        textColor: '#ffffff',
        strokeColor: '#000000',
        strokeWidth: 1,
        textMargin: 1,
        lineHeight: 1.25,
      },
      frames: 24,
      sampleRate: 48000,
      channels: 2,
      videoBitrate: 1000,
      audioBitrate: 128000,
      maxChunkBytes: 4096,
      maxActiveSources: 4,
      sourceCacheBytes: 4096,
      maxImageBytes: 4096,
      maxSourcePixels: 4096,
      audioWindowSamples: 1024,
      heartbeatMs: 1000,
      segments: [
        {
          key: brandString<TimelineRenderWork['plan']['key']>('a'.repeat(64)),
          fromFrame: 0,
          toFrame: 24,
          videoPath: '/cache/video.mp4',
          audioPath: '/cache/audio.pcm',
          cached: false,
        },
      ],
    },
  }
}
const notice = (id: Job): TimelineRenderNotice => ({
  sessionId: session,
  directory: '/project',
  node: brandString<CanvasNodeId>('n1'),
  episode: brandString<EpisodeId>('e1'),
  jobId: id,
  state: 'queued',
  revision: 1,
})
const workers: TimelineWorker[] = []
function fixture() {
  const port: TimelineWorkerPort = {
    pending: vi.fn(async () => []),
    claim: vi.fn<TimelineWorkerPort['claim']>(async (_session, id) => work(id)),
    io: () => ({
      read: vi.fn(),
      size: vi.fn(),
      compatible: vi.fn(),
      append: vi.fn(),
      complete: vi.fn(),
      progress: vi.fn(),
      report: vi.fn(),
    }),
    fail: vi.fn(async () => {}),
    report: vi.fn(),
  }
  const worker = new TimelineWorker(port)
  workers.push(worker)
  return { worker, port }
}
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.dispose()))
  render.mockReset()
})

it('starts from a render notification without an editor and runs only one codec job at a time', async () => {
  const first: PromiseWithResolvers<void> = Promise.withResolvers(),
    second: PromiseWithResolvers<void> = Promise.withResolvers()
  render.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const { worker, port } = fixture()
  worker.changed(notice(job('one')))
  worker.changed(notice(job('two')))
  try {
    await expect.poll(() => render.mock.calls.length).toBe(1)
    expect(port.claim).toHaveBeenCalledTimes(1)
    first.resolve()
    await expect.poll(() => render.mock.calls.length).toBe(2)
    expect(port.claim).toHaveBeenNthCalledWith(2, session, job('two'))
  } finally {
    first.resolve()
    second.resolve()
  }
})

it('reports a structured source failure to the Host and continues with the next job', async () => {
  render.mockRejectedValueOnce(new TimelineRenderFailure('source', 'source disappeared')).mockResolvedValue(undefined)
  const { worker, port } = fixture()
  worker.changed(notice(job('one')))
  worker.changed(notice(job('two')))
  await expect.poll(() => render.mock.calls.length).toBe(2)
  expect(port.fail).toHaveBeenCalledWith(session, work(job('one')), 'source', 'source disappeared')
  expect(port.report).toHaveBeenCalledTimes(1)
})

it('deduplicates discovery and ignores a delayed response from the replaced connection', async () => {
  render.mockResolvedValue(undefined)
  const previous = Promise.withResolvers<readonly Job[]>(),
    { worker, port } = fixture()
  vi.mocked(port.pending)
    .mockImplementationOnce(() => previous.promise)
    .mockResolvedValueOnce([job('new')])
  worker.wake(session)
  worker.wake(session)
  await expect.poll(() => vi.mocked(port.pending).mock.calls.length).toBe(1)
  worker.reset()
  previous.resolve([job('old')])
  await expect.poll(() => render.mock.calls.length).toBe(1)
  expect(port.pending).toHaveBeenCalledTimes(2)
  expect(port.claim).toHaveBeenCalledWith(session, job('new'))
  expect(port.claim).not.toHaveBeenCalledWith(session, job('old'))
})

it('closes admission and joins a pending claim before disposal completes', async () => {
  const accepted = Promise.withResolvers<TimelineRenderWork | undefined>(),
    { worker, port } = fixture()
  vi.mocked(port.claim).mockReturnValue(accepted.promise)
  worker.changed(notice(job('one')))
  await expect.poll(() => vi.mocked(port.claim).mock.calls.length).toBe(1)
  let disposed = false
  const closing = worker.dispose().then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(disposed).toBe(false)
  accepted.resolve(work(job('one')))
  await closing
  worker.changed(notice(job('two')))
  worker.wake(session)
  expect(render).not.toHaveBeenCalled()
  expect(port.claim).toHaveBeenCalledTimes(1)
  expect(port.fail).not.toHaveBeenCalled()
})
