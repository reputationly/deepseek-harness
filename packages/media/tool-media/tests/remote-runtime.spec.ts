/** The Remote media runtime plans, starts, and cancels against the canvas and jobs services. */
import { expect, it, vi } from 'vitest'
import type { CanvasService } from '@deepseek-ai/dsh-canvas'
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import type { Session } from '@deepseek-ai/dsh-session'
import { createMediaRuntime, type MediaRuntimeDeps } from '../src/remote-runtime.ts'

const image = (id: string, extra: Record<string, unknown> = {}) => ({
  id: id as never, type: 'image' as const, title: id, x: 0, y: 0, width: 100, height: 100,
  activeVersion: 'v1' as never,
  versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user' as const, path: `/p/${id}.png` }],
  gen: { kind: 'image' as const, prompt: 'a cat', params: {} },
  ...extra,
})
const doc = (nodes: readonly unknown[], edges: readonly unknown[] = []): CanvasDocument => ({
  version: 2, revision: 1, nextId: nodes.length + 1, nodes: nodes as never, edges: edges as never,
})
const session = { id: 's1' } as Session

function runtime(overrides: { document?: CanvasDocument; kill?: () => 'requested' | 'already-finished' } = {}) {
  const read = vi.fn(async () => overrides.document ?? doc([image('n1')]))
  const edit = vi.fn(async () => ({ revision: 2, refs: {}, created: [], skipped: [] }))
  const canvas = {
    projectOf: vi.fn(async () => ({ project: undefined })),
    read,
    bibleOf: vi.fn(async () => ({ bible: { version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' }, entries: [] } })),
    edit,
  } as never as CanvasService
  const start = vi.fn((spec: { run: (signal: AbortSignal) => Promise<{ path: string; model: string }> }) => {
    const controller = new AbortController()
    return { id: 'j1' as never, done: spec.run(controller.signal), signal: controller.signal }
  })
  const deps: MediaRuntimeDeps = {
    canvasOf: () => canvas,
    tools: {
      canvas: () => canvas,
      limits: {
        maxVideoSeconds: 15, videoDefaultDuration: 5, videoModel: 'm', videoRefModel: 'm', imageModel: 'm',
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

it('asks for confirmation when the plan crosses the image threshold', async () => {
  const h = runtime({ document: doc([image('n1'), image('n2'), image('n3')]) })
  await expect(h.runtime.plan(session, ['n1', 'n2', 'n3'])).resolves.toMatchObject({
    state: 'needs_confirmation', token: expect.any(String),
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
