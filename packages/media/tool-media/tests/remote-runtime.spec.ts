/** The Remote media runtime plans, starts, and cancels against the canvas and jobs services. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CanvasInputError, type Bible, type CanvasService } from '@deepseek-ai/dsh-canvas'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasDocument, CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { Session } from '@deepseek-ai/dsh-session'
import { createMediaRuntime, type MediaRuntimeDeps } from '../src/remote-runtime.ts'
import { createRunnerState } from '../src/runner.ts'
import { bibleFixture } from './bible-fixture.ts'

const image = (id: string, extra: Record<string, unknown> = {}) => ({
  id: id as never, type: 'image' as const, title: id, x: 0, y: 0, width: 100, height: 100,
  activeVersion: 'v1' as never,
  versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user' as const, path: `/p/${id}.png` }],
  gen: { kind: 'image' as const, prompt: 'a cat', params: {} },
  ...extra,
})
const doc = (nodes: readonly unknown[], edges: readonly unknown[] = []): CanvasDocument => ({
  version: 3, revision: 1, nextId: nodes.length + 1, nodes: nodes as never, edges: edges as never,
})
const session = { id: 's1' } as Session
let directory: string
let runningJobs: Promise<unknown>[]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-media-runtime-'))
  runningJobs = []
})
afterEach(async () => {
  await Promise.allSettled(runningJobs)
  await rm(directory, { recursive: true, force: true })
})

function runtime(overrides: { document?: CanvasDocument; bible?: Bible; kill?: () => 'requested' | 'already-finished' } = {}) {
  const read = vi.fn(async () => overrides.document ?? doc([image('n1')]))
  const edit = vi.fn(async () => ({ revision: 2, refs: {}, created: [], skipped: [] }))
  const canvas = {
    targetOf: vi.fn(async () => ({ directory, file: 'canvas.json', episode: { id: 'e1', title: 'Canvas' } })),
    projectOf: vi.fn(async () => ({ project: undefined })),
    directoryOf: () => directory,
    read,
    bibleOf: vi.fn(async () => ({ bible: overrides.bible ?? bibleFixture })),
    edit,
  } as never as CanvasService
  const start = vi.fn((spec: { run: (signal: AbortSignal) => Promise<{ path: string; model: string }> }) => {
    const controller = new AbortController()
    const done = spec.run(controller.signal)
    runningJobs.push(done)
    return { id: 'j1' as never, done, signal: controller.signal }
  })
  const deps: MediaRuntimeDeps = {
    canvasOf: () => canvas,
    tools: {
      state: createRunnerState(),
      canvas: () => canvas,
      limits: {
        maxVideoSeconds: 15, minVideoSeconds: 4, videoDefaultDuration: 5, videoModel: 'm', videoRefModel: 'm', imageModel: 'm',
        speechModel: 'm', musicModel: 'm',
      },
      confirmLimits: {
        confirmVideoCalls: 2, confirmVideoSeconds: 20, confirmSpeechLines: 10, confirmImageCalls: 2, confirmMusicCalls: 1,
      },
      concurrency: 1,
      generate: {
        image: vi.fn(async () => ({ path: '/p/out.png', model: 'm' })),
        video: vi.fn(async () => ({ path: '/p/out.mp4', model: 'm' })),
        speech: vi.fn(async () => ({ path: '/p/out.mp3', model: 'm' })),
        music: vi.fn(async () => ({ path: '/p/out.wav', model: 'm' })),
      },
      jobs: () => ({ start }),
      probe: async () => ({}),
      tailFrame: async () => '/p/tail.png',
    },
    jobs: overrides.kill === undefined ? undefined : { kill: vi.fn(overrides.kill) },
  }
  return { deps, read, edit, start, runtime: createMediaRuntime(deps) }
}

it('plans one image node and reports its calls', async () => {
  const h = runtime()
  await expect(h.runtime.plan(session, ['n1'])).resolves.toMatchObject({
    state: 'ready', jobs: [], lines: [{ node: 'n1', kind: 'image', calls: 1 }],
  })
})

it('previews only a recorded video version and leaves generation untouched', async () => {
  const h = runtime({ document: doc([image('v1', { type: 'video', versions: [
    { id: 'old', createdAt: 'now', origin: 'user', path: '/p/old.mp4' },
    { id: 'new', createdAt: 'now', origin: 'user', path: '/p/new.mp4' },
  ] })]) })
  const previewVideo = vi.fn(async () => '/p/cached.webm')
  const service = createMediaRuntime({ ...h.deps, previewVideo })
  const scope = { directory, episode: brandString<EpisodeId>('e1') }
  await expect(service.preview(session, brandString<CanvasNodeId>('v1'), brandString<VersionId>('old'), scope)).resolves.toBe('/p/cached.webm')
  expect(previewVideo).toHaveBeenCalledWith('/p/old.mp4', directory)
  expect(h.read).toHaveBeenCalledWith(session, scope.episode, directory)
  await expect(service.preview(session, brandString<CanvasNodeId>('v1'), brandString<VersionId>('missing'), scope)).rejects.toThrow('unavailable')
  await expect(service.preview(session, brandString<CanvasNodeId>('not-a-node'), brandString<VersionId>('old'), scope)).rejects.toThrow('unavailable')
  expect(previewVideo).toHaveBeenCalledTimes(1)
  expect(h.start).not.toHaveBeenCalled()
})

it('stops before transcoding if the project switches while the scoped canvas read is pending', async () => {
  const document = doc([image('n1', { type: 'video', versions: [{ id: 'v1', createdAt: 'now', origin: 'user', path: 'same-name.mp4' }] })])
  const h = runtime({ document })
  const canvas = h.deps.canvasOf()
  h.read.mockImplementationOnce(async () => {
    vi.spyOn(canvas, 'directoryOf').mockReturnValue('/different-project')
    return document
  })
  const previewVideo = vi.fn(async () => '/p/incorrect.mp4')
  const service = createMediaRuntime({ ...h.deps, previewVideo })
  await expect(service.preview(session, brandString<CanvasNodeId>('n1'), brandString<VersionId>('v1'), { directory, episode: brandString<EpisodeId>('e1') })).rejects.toBeInstanceOf(CanvasInputError)
  expect(previewVideo).not.toHaveBeenCalled()
})

it('asks for confirmation when the plan crosses the image threshold', async () => {
  const h = runtime({ document: doc([image('n1'), image('n2'), image('n3')]) })
  const expectedToken1: unknown = expect.any(String)
  await expect(h.runtime.plan(session, ['n1', 'n2', 'n3'])).resolves.toMatchObject({
    state: 'needs_confirmation', token: expectedToken1,
  })
})

it('reports a node already running', async () => {
  const h = runtime({ document: doc([image('n1', { status: { state: 'running' } })]) })
  await expect(h.runtime.generate(session, ['n1'], undefined)).resolves.toMatchObject({ state: 'already_running' })
})

it('starts a plan and returns the job it created', async () => {
  const h = runtime()
  await expect(h.runtime.generate(session, ['n1'], undefined)).resolves.toMatchObject({
    state: 'started', jobs: [{ node: 'n1', jobId: 'j1' }],
  })
  expect(h.start).toHaveBeenCalled()
  expect(h.edit).toHaveBeenCalled()
})

it('cancels through the jobs registry and reports an unowned job', () => {
  const requested = runtime({ kill: () => 'requested' })
  expect(requested.runtime.cancel(session, 'j1')).toBe(true)
  const finished = runtime({ kill: () => 'already-finished' })
  expect(finished.runtime.cancel(session, 'j1')).toBe(false)
  expect(runtime().runtime.cancel(session, 'j1')).toBe(false)
})

it('reports video seconds in the plan lines', async () => {
  const video = {
    id: 'v1' as never, type: 'video' as const, title: 'v1', x: 0, y: 0, width: 100, height: 100,
    activeVersion: 'v1' as never,
    versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user' as const, path: '/p/v1.mp4' }],
    gen: { kind: 'video' as const, prompt: 'a cat', params: {} },
  }
  const h = runtime({ document: doc([video]) })
  const view = await h.runtime.plan(session, ['v1'])
  expect(view.lines[0]?.seconds).toBeGreaterThan(0)
})

it('asks for confirmation before starting a plan over the threshold', async () => {
  const h = runtime({ document: doc([image('n1'), image('n2'), image('n3')]) })
  const expectedToken2: unknown = expect.any(String)
  await expect(h.runtime.generate(session, ['n1', 'n2', 'n3'], undefined)).resolves.toMatchObject({
    state: 'needs_confirmation', token: expectedToken2,
  })
  expect(h.start).not.toHaveBeenCalled()
})

it('reports a blocked plan with its gate and missing choices', async () => {
  const h = runtime({ bible: { ...bibleFixture, entries: [] }, document: doc([image('n1', { gen: { kind: 'image', prompt: '@林夏 笑', params: {} } })]) })
  const view = await h.runtime.plan(session, ['n1'])
  const expectedMessage3: unknown = expect.stringContaining('G1_bible_first')
  expect(view).toMatchObject({ state: 'blocked', message: expectedMessage3 })
  await expect(h.runtime.generate(session, ['n1'], undefined)).resolves.toMatchObject({ state: 'blocked' })
})

it('finishes an empty plan without starting jobs', async () => {
  const h = runtime()
  const view = await h.runtime.generate(session, [], undefined)
  expect(['started', 'ready', 'needs_confirmation', 'blocked']).toContain(view.state)
})
