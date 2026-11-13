/** The node-tool dependency factory wraps jobs, probes media, and extracts tail frames. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JobHandle, JobId } from '@deepseek-ai/dsh-jobs'
import { createNodeToolDeps, type JobsRegistry } from '../src/node-deps.ts'
import type { MediaGenerator } from '../src/runner.ts'

const config = {
  maxSegmentSeconds: 15, videoDefaultDuration: 5, videoModel: 'vm', videoRefModel: 'vrm', imageModel: 'im',
  speechModel: 'sm', musicModel: 'mm', confirmVideoCalls: 2, confirmVideoSeconds: 20, confirmSpeechLines: 5,
  confirmImageCalls: 2, confirmMusicCalls: 1, generateConcurrency: 1, outputDir: '/tmp/out',
}
const session = { id: 's1' } as Session

function registry() {
  const append = vi.fn()
  const kill = vi.fn()
  const job = { append, appendLine: vi.fn(), ids: {} as never } as unknown as JobHandle
  let captured: Parameters<JobsRegistry['start']>[0] | undefined
  let handle: ReturnType<Parameters<JobsRegistry['start']>[0]['run']> | undefined
  const start = vi.fn((spec: Parameters<JobsRegistry['start']>[0]) => {
    captured = spec
    handle = spec.run(job)
    return 'j1' as JobId
  })
  return { start, append, kill, job, spec: () => captured!, handle: () => handle! }
}

afterEach(async () => { vi.restoreAllMocks() })

it('wraps a generator run into a media job that logs its progress', async () => {
  const r = registry()
  const partialGenerator = { image: vi.fn(async () => ({ path: '/p/out.png', model: 'm' })) }
  const generator = partialGenerator as never as MediaGenerator
  const deps = createNodeToolDeps({
    canvas: () => undefined, resolved: config, generator, jobs: { start: r.start },
    ffmpeg: { probe: vi.fn(), exec: vi.fn() },
  })
  const job = deps.jobs(session).start({ label: 'image n1', run: () => generator.image({} as never) })
  expect(job.id).toBe('j1')
  await expect(job.done).resolves.toMatchObject({ path: '/p/out.png' })
  expect(r.append).toHaveBeenCalled()
  expect(r.handle().cancel).toBeTypeOf('function')
})

it('reports a failed run and an aborted signal', async () => {
  const r = registry()
  const failingGenerator = { image: vi.fn(async () => { throw new Error('boom') }) }
  const generator = failingGenerator as never as MediaGenerator
  const deps = createNodeToolDeps({
    canvas: () => undefined, resolved: config, generator, jobs: { start: r.start },
    ffmpeg: { probe: vi.fn(), exec: vi.fn() },
  })
  const run = deps.jobs(session).start({ label: 'image n1', run: () => generator.image({} as never) })
  r.handle().cancel('user')
  await expect(run.done).rejects.toThrow('boom')
  expect(r.append).toHaveBeenCalledWith(expect.stringContaining('boom'), { channel: 'log' })
})

it('refuses to start without a jobs service', () => {
  const deps = createNodeToolDeps({
    canvas: () => undefined, resolved: config, generator: {} as never, jobs: undefined,
    ffmpeg: { probe: vi.fn(), exec: vi.fn() },
  })
  expect(() => deps.jobs(session).start({ label: 'x', run: async () => ({ path: '/p', model: 'm' }) })).toThrow('jobs service')
})

it('probes duration and picture size, tolerating a missing video stream', async () => {
  const probe = vi.fn()
    .mockResolvedValueOnce({ streams: [{ codec_type: 'video', width: 1080, height: 1920 }], format: { duration: '3.5' } })
    .mockResolvedValueOnce({})
  const deps = createNodeToolDeps({
    canvas: () => undefined, resolved: config, generator: {} as never, jobs: undefined,
    ffmpeg: { probe, exec: vi.fn() },
  })
  await expect(deps.probe('/p/a.mp4')).resolves.toEqual({ durationMs: 3500, width: 1080, height: 1920 })
  await expect(deps.probe('/p/a.mp4')).resolves.toEqual({})
})

it('extracts the last frame next to an absolute output directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-deps-'))
  try {
    const exec = vi.fn(async (args: readonly string[]) => { await writeFile(args.at(-1) as string, 'frame-bytes') })
    const deps = createNodeToolDeps({
      canvas: () => undefined, resolved: { ...config, outputDir: directory }, generator: {} as never,
      jobs: undefined, ffmpeg: { probe: vi.fn(), exec },
    })
    const target = await deps.tailFrame('/p/a.mp4')
    expect(target.startsWith(directory)).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('frame-bytes')
    expect(exec).toHaveBeenCalled()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('resolves a relative output directory against the process cwd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-node-deps-rel-'))
  const previous = process.cwd()
  try {
    process.chdir(directory)
    const exec = vi.fn(async (args: readonly string[]) => { await writeFile(args.at(-1) as string, 'bytes') })
    const deps = createNodeToolDeps({
      canvas: () => undefined, resolved: { ...config, outputDir: 'media-out' }, generator: {} as never,
      jobs: undefined, ffmpeg: { probe: vi.fn(), exec },
    })
    const target = await deps.tailFrame('/p/a.mp4')
    expect(target).toContain('media-out')
  } finally {
    process.chdir(previous)
    await rm(directory, { recursive: true, force: true })
  }
})
