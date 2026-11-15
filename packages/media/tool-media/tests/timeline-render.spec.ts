import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CanvasService from '@deepseek-ai/dsh-canvas'
import type { CanvasNodeId, EpisodeId, TimelineTrackId, TimelineClipId } from '@deepseek-ai/dsh-canvas/client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { JobId, type JobHooks } from '@deepseek-ai/dsh-jobs'
import { TimelineRenderer, type TimelineRendererDeps } from '../src/timeline-render.ts'
import type { TimelineRenderWork } from '../src/timeline-render-types.ts'

let ctx: Context, directory: string, session: Session, renderer: TimelineRenderer, deps: TimelineRendererDeps
let jobs: Map<JobId, JobHooks>
const node = brandString<CanvasNodeId>('n1'),
  track = brandString<TimelineTrackId>('t1'),
  clip = brandString<TimelineClipId>('k1')
const spec = { width: 320, height: 240, fps: 24 } as const
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-timeline-render-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService)
  session = Session.create(SessionId('local-render'))
  await ctx.canvas.edit(session, [{ op: 'add', type: 'timeline' }], { baseRevision: 0 })
  await ctx.canvas.editTimeline(
    session,
    node,
    [
      {
        op: 'add_track',
        track: {
          id: track,
          kind: 'text',
          volume: 1,
          muted: false,
          clips: [{ id: clip, startMs: 0, durationMs: 1000, text: { content: '你好', size: 20, position: 'bottom' } }],
        },
      },
    ],
    0,
    spec,
  )
  jobs = new Map()
  deps = {
    canvas: () => ctx.canvas,
    config: {
      chunkFrames: 12,
      maxChunkBytes: 262144,
      leaseTimeoutMs: 60000,
      maxActiveSources: 8,
      videoBitsPerPixel: 0.14,
      audioBitrate: 192000,
      fontFamily: 'sans-serif',
      compatibility: { crf: 18, preset: 'fast', audioBitrate: 192000 },
      sourceCacheBytes: 1048576,
      maxImageBytes: 33554432,
      maxSourcePixels: 16777216,
      audioWindowSamples: 4096,
      heartbeatMs: 2500,
    },
    compatible: async asset => asset,
    jobs: {
      start: (definition) => {
        const id = JobId(`media-${String(jobs.size)}`)
        jobs.set(id, definition.run({ id, append: () => undefined, updateProgress: () => undefined }))
        return id
      },
    },
    // Probe is the process boundary; these tests judge leasing and durable bytes, not encoded media quality.
    ffmpeg: {
      probe: async path => ({
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 320, height: 240, avg_frame_rate: '24/1' },
          { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: '1' },
        ],
        format: { duration: path.includes('.video.mp4') ? '0.5' : '1' },
      }),
    },
    notify: vi.fn(),
    report: vi.fn(),
  }
  renderer = new TimelineRenderer(deps)
})
afterEach(async () => {
  await renderer.dispose()
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function claim(): Promise<TimelineRenderWork> {
  const queued = await renderer.start(session, node, 1)
  const work = queued.jobId === undefined ? undefined : await renderer.claim(session, queued.jobId, 'test-renderer-v1')
  if (work === undefined) throw new Error('render work was not queued')
  return work
}

it('rejects rendering and clearing addressed to a different project without starting jobs', async () => {
  const other = join(directory, 'other-project')
  await expect(renderer.start(session, node, 1, brandString<EpisodeId>('e1'), other)).rejects.toThrow('project changed')
  await expect(renderer.clear(session, node, brandString<EpisodeId>('e1'), other)).rejects.toThrow('project changed')
  expect(jobs.size).toBe(0)
})

it('marks UI renders quiet while retaining completion delivery for model render tools', async () => {
  const start = vi.spyOn(deps.jobs!, 'start')
  await renderer.start(session, node, 1, undefined, undefined, 'none')
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ owner: session.id, completionNotice: 'none' }))
  await renderer.dispose()
  renderer = new TimelineRenderer(deps)
  await renderer.start(session, node, 1)
  expect(start.mock.calls.at(-1)?.[0]).not.toHaveProperty('completionNotice')
})

it('deduplicates starts and grants exactly one renderer lease', async () => {
  const starts = await Promise.all([renderer.start(session, node, 1), renderer.start(session, node, 1)])
  expect(starts[0]?.jobId).toBe(starts[1]?.jobId)
  expect(jobs.size).toBe(1)
  const id = starts[0]?.jobId
  if (id === undefined) throw new Error('no job')
  const claims = await Promise.all([
    renderer.claim(session, id, 'test-renderer-v1'),
    renderer.claim(session, id, 'test-renderer-v1'),
  ])
  expect(claims.filter(Boolean)).toHaveLength(1)
  expect((await renderer.status(session, node)).state).toBe('rendering')
})
it('streams atomic blocks, reuses completed files, and publishes only the complete matching output', async () => {
  const work = await claim()
  for (const segment of work.plan.segments) {
    const video = { kind: 'video', segment: segment.key } as const,
      audio = { kind: 'audio', segment: segment.key } as const
    await renderer.append(session, work.jobId, work.lease, video, 0, new Uint8Array([1, 2, 3]))
    await renderer.complete(session, work.jobId, work.lease, video)
    await renderer.append(session, work.jobId, work.lease, audio, 0, new Uint8Array(192000))
    await renderer.complete(session, work.jobId, work.lease, audio)
  }
  await renderer.append(session, work.jobId, work.lease, { kind: 'output' }, 0, new Uint8Array([7, 8, 9]))
  const completed = await renderer.complete(session, work.jobId, work.lease, { kind: 'output' })
  expect(completed.state).toBe('ready')
  expect(await readFile(completed.path!)).toEqual(Buffer.from([7, 8, 9]))
  expect((await jobs.get(work.jobId)?.done)?.status).toBe('completed')
  expect((await renderer.start(session, node, 1)).path).toBe(completed.path)
  expect(jobs.size).toBe(1)
  const exported = await renderer.export(session, node, 1)
  expect(await renderer.export(session, node, 1)).toEqual(exported)
  expect((await ctx.canvas.read(session)).nodes.filter(candidate => candidate.type === 'video')).toHaveLength(1)
  await renderer.clear(session, node)
  expect(await readFile(exported.path)).toEqual(Buffer.from([7, 8, 9]))
})
it('rejects stale revisions, cross-session leases, and out-of-order or oversized uploads', async () => {
  await expect(renderer.start(session, node, 0)).rejects.toThrow('revision')
  const work = await claim(),
    part = { kind: 'output' } as const
  await expect(
    renderer.append(Session.create(SessionId('other')), work.jobId, work.lease, part, 0, new Uint8Array([1])),
  ).rejects.toThrow('Session')
  await expect(renderer.append(session, work.jobId, work.lease, part, 1, new Uint8Array([1]))).rejects.toThrow('zero')
  await expect(renderer.append(session, work.jobId, work.lease, part, 0, new Uint8Array(262145))).rejects.toThrow(
    'window',
  )
  expect((await renderer.status(session, node)).path).toBeUndefined()
})
it('validates encoded upload windows and refuses a final output without complete cache blocks', async () => {
  const work = await claim(),
    part = { kind: 'output' } as const
  await expect(renderer.appendEncoded(session, work.jobId, work.lease, part, 0, '%%%%')).rejects.toMatchObject({
    code: 'upload',
  })
  await expect(renderer.appendEncoded(session, work.jobId, work.lease, part, 0, 'A')).rejects.toMatchObject({
    code: 'upload',
  })
  expect(await renderer.appendEncoded(session, work.jobId, work.lease, part, 0, 'AQID')).toBe(3)
  await expect(renderer.complete(session, work.jobId, work.lease, part)).rejects.toMatchObject({ code: 'upload' })
  expect((await renderer.status(session, node)).path).toBeUndefined()
})
it('isolates resumed segment identities when the browser encoder environment changes', async () => {
  const first = await claim()
  jobs.get(first.jobId)!.cancel('unload', 'teardown')
  await jobs.get(first.jobId)!.done
  const queued = await renderer.start(session, node, 1)
  const second = await renderer.claim(session, queued.jobId!, 'different-browser-and-gpu')
  expect(second?.plan.key).not.toBe(first.plan.key)
  expect(second?.plan.segments[0]?.key).not.toBe(first.plan.segments[0]?.key)
  expect(second?.plan.segments.every(segment => !segment.cached)).toBe(true)
})
async function uploadBlocks(work: TimelineRenderWork): Promise<void> {
  for (const segment of work.plan.segments) {
    const video = { kind: 'video', segment: segment.key } as const,
      audio = { kind: 'audio', segment: segment.key } as const
    await renderer.append(session, work.jobId, work.lease, video, 0, new Uint8Array([1, 2, 3]))
    await renderer.complete(session, work.jobId, work.lease, video)
    await renderer.append(session, work.jobId, work.lease, audio, 0, new Uint8Array(192000))
    await renderer.complete(session, work.jobId, work.lease, audio)
  }
}

function outputProbe(durations: { video?: string; audio?: string; format?: string }) {
  return {
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 320, height: 240, avg_frame_rate: '24/1', duration: durations.video },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, duration: durations.audio },
    ],
    format: { duration: durations.format },
  }
}

it('accepts an output whose container duration exceeds the video by encoder audio padding', async () => {
  const work = await claim()
  await uploadBlocks(work)
  vi.spyOn(deps.ffmpeg, 'probe').mockResolvedValue(outputProbe({ video: '1', audio: '1.08', format: '1.08' }) as never)
  await renderer.append(session, work.jobId, work.lease, { kind: 'output' }, 0, new Uint8Array([7]))
  const completed = await renderer.complete(session, work.jobId, work.lease, { kind: 'output' })
  expect(completed.state).toBe('ready')
})

it('rejects an output whose video stream is three frames short', async () => {
  const work = await claim()
  await uploadBlocks(work)
  vi.spyOn(deps.ffmpeg, 'probe').mockResolvedValue(outputProbe({ video: '0.875', audio: '0.875', format: '0.875' }) as never)
  await renderer.append(session, work.jobId, work.lease, { kind: 'output' }, 0, new Uint8Array([7]))
  await expect(renderer.complete(session, work.jobId, work.lease, { kind: 'output' })).rejects.toMatchObject({
    code: 'probe', message: 'render video does not match its output specification',
  })
})

it('rejects an output whose audio runs far past the timeline', async () => {
  const work = await claim()
  await uploadBlocks(work)
  vi.spyOn(deps.ffmpeg, 'probe').mockResolvedValue(outputProbe({ video: '1', audio: '1.3', format: '1.3' }) as never)
  await renderer.append(session, work.jobId, work.lease, { kind: 'output' }, 0, new Uint8Array([7]))
  await expect(renderer.complete(session, work.jobId, work.lease, { kind: 'output' })).rejects.toMatchObject({
    code: 'probe', message: 'render output audio does not match the timeline duration',
  })
})

it('keeps validating a segment block against its own video stream duration', async () => {
  const work = await claim()
  const segment = work.plan.segments[0]!
  const video = { kind: 'video', segment: segment.key } as const
  const originalProbe = await deps.ffmpeg.probe('fixture')
  vi.spyOn(deps.ffmpeg, 'probe').mockResolvedValue({
    ...originalProbe,
    streams: originalProbe.streams!.map(stream =>
      stream.codec_type === 'video' ? { ...stream, duration: '0.5' } : stream),
    format: { duration: '0.5' },
  })
  await renderer.append(session, work.jobId, work.lease, video, 0, new Uint8Array([1, 2, 3]))
  const completed = await renderer.complete(session, work.jobId, work.lease, video)
  expect(completed.state).not.toBe('failed')
})

it('rejects a video block with a different frame rate before publishing the block', async () => {
  const work = await claim(),
    part = { kind: 'video', segment: work.plan.segments[0]!.key } as const
  const originalProbe = await deps.ffmpeg.probe('fixture')
  vi.spyOn(deps.ffmpeg, 'probe').mockResolvedValue({
    ...originalProbe,
    streams: originalProbe.streams!.map(stream => ({ ...stream, avg_frame_rate: '30/1' })),
  })
  await renderer.append(session, work.jobId, work.lease, part, 0, new Uint8Array([1, 2, 3]))
  await expect(renderer.complete(session, work.jobId, work.lease, part)).rejects.toMatchObject({ code: 'probe' })
  expect((await renderer.status(session, node)).path).toBeUndefined()
})
it('fences old work when an edit wins before publication', async () => {
  const work = await claim()
  await renderer.append(session, work.jobId, work.lease, { kind: 'output' }, 0, new Uint8Array([1]))
  await ctx.canvas.editTimeline(
    session,
    node,
    [{ op: 'set_clip', clip, patch: { text: { content: '手动修改', position: 'top', size: 20 } } }],
    1,
    undefined,
  )
  await renderer.complete(session, work.jobId, work.lease, { kind: 'output' })
  expect(await renderer.status(session, node)).toMatchObject({ revision: 2, state: 'stale' })
  expect((await jobs.get(work.jobId)?.done)?.status).toBe('killed')
})
it('cleans partial uploads on explicit cancellation and never resumes the cancelled job', async () => {
  const work = await claim()
  await renderer.append(session, work.jobId, work.lease, { kind: 'output' }, 0, new Uint8Array([1]))
  jobs.get(work.jobId)?.cancel()
  await jobs.get(work.jobId)?.done
  expect((await renderer.status(session, node)).state).toBe('cancelled')
  await expect(
    renderer.append(session, work.jobId, work.lease, { kind: 'output' }, 1, new Uint8Array([1])),
  ).rejects.toThrow('lease')
  expect(
    (await readdir(join(directory, '.canvas', 'canvas.json.render', node))).some(file => file.endsWith('.part')),
  ).toBe(false)
  await renderer.dispose()
  renderer = new TimelineRenderer(deps)
  await renderer.recover(session, brandString<EpisodeId>('e1'))
  expect(renderer.pending(session)).toEqual([])
})
it('restarts interrupted local work with a fresh lease and cleans the old temporary output', async () => {
  const work = await claim()
  await renderer.append(session, work.jobId, work.lease, { kind: 'output' }, 0, new Uint8Array([1]))
  await renderer.dispose()
  renderer = new TimelineRenderer(deps)
  await renderer.recover(session, brandString<EpisodeId>('e1'))
  expect(renderer.pending(session)).toHaveLength(1)
  const resumed = await renderer.claim(session, renderer.pending(session)[0]!, 'test-renderer-v1')
  expect(resumed?.lease).not.toBe(work.lease)
  expect(
    (await readdir(join(directory, '.canvas', 'canvas.json.render', node))).some(file => file.endsWith('.part')),
  ).toBe(false)
})
it('requeues expired work and refuses writes under the previous lease', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
  const work = await claim()
  clock.mockReturnValue(160001)
  await renderer.expireLeases()
  const replacement = await renderer.claim(session, work.jobId, 'test-renderer-v1')
  expect(replacement?.lease).not.toBe(work.lease)
  await expect(
    renderer.append(session, work.jobId, work.lease, { kind: 'output' }, 0, new Uint8Array([1])),
  ).rejects.toThrow('lease')
})
