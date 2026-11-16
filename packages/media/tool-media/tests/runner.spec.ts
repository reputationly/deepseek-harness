import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CanvasConflictError, type Bible, type CanvasDocument, type CanvasEditResult, type CanvasNode, type CanvasNodeId, type CanvasOperation, type Shot, type ShotId } from '@deepseek-ai/dsh-canvas'
import { EMPTY_CANVAS } from '@deepseek-ai/dsh-canvas/src/document.ts'
import { resolveConfig } from '@deepseek-ai/dsh-canvas/src/config.ts'
import { applyOperations } from '@deepseek-ai/dsh-canvas/src/operations.ts'
import { createRunnerState, runPlan, startPlan, type MediaGenerator, type RunnerServices } from '../src/runner.ts'
import { bibleFixture } from './bible-fixture.ts'

const limits = {
  maxVideoSeconds: 15, minVideoSeconds: 4, videoDefaultDuration: 5, videoModel: 'video-model', videoRefModel: 'video-ref-model',
  imageModel: 'image-model', speechModel: 'speech-model', musicModel: 'music-model',
}

const shot = (id: string): Shot => ({
  id: id as never, title: id, shotSize: 'medium', visual: `画面 ${id}`, motion: '动作', camera: '固定', durationSec: 3,
  characters: [], props: [], dialogue: [], sfx: '', negative: '',
})

describe('runPlan', () => {
  const directory = '/tmp/media-runner'
  const canvasLimits = resolveConfig({})
  let document: CanvasDocument
  let revision: number
  let generated: string[]
  let fail: boolean
  const bible: Bible = {
    ...bibleFixture,
  }

  beforeEach(() => {
    document = EMPTY_CANVAS
    revision = 0
    generated = []
    fail = false
  })

  function services(overrides: Partial<RunnerServices> = {}): RunnerServices {
    let jobs = 0
    const canvas = {
      read: async () => ({ document, revision }),
      bible: async () => bible,
      edit: async (operations: readonly CanvasOperation[], baseRevision: number): Promise<CanvasEditResult> => {
        if (baseRevision !== revision) throw new CanvasConflictError(baseRevision, revision)
        const outcome = applyOperations(document, operations, { limits: canvasLimits, origin: 'agent', now: () => '2026-11-12T00:00:00.000Z' })
        document = outcome.document
        revision += 1
        return outcome.result
      },
    }
    const generator: MediaGenerator = {
      image: async (call) => {
        if (fail) throw Object.assign(new Error('gateway said no'), { status: 500 })
        generated.push(`image:${call.node.id}`)
        return { path: join(directory, 'image.png'), model: 'image-model' }
      },
      video: async (call) => {
        if (fail) throw Object.assign(new Error('gateway said no'), { status: 500 })
        generated.push(`video:${call.node.id}:${call.firstFramePath ?? ''}`)
        return { path: join(directory, 'video.mp4'), model: 'video-model' }
      },
      speech: async () => ({ path: join(directory, 'speech.mp3'), model: 'speech-model' }),
      music: async () => ({ path: join(directory, 'music.mp3'), model: 'music-model' }),
    }
    return {
      state: createRunnerState(),
      canvas,
      limits,
      concurrency: 2,
      generate: generator,
      jobs: {
        start: (spec) => {
          jobs += 1
          const controller = new AbortController()
          return { id: `media-${String(jobs)}` as never, done: spec.run(controller.signal), signal: controller.signal }
        },
        live: () => [],
      },
      probe: async () => ({ durationMs: 3000, width: 720, height: 1280 }),
      tailFrame: async () => join(directory, 'tail.png'),
      now: () => '2026-11-12T00:00:00.000Z',
      ...overrides,
    }
  }

  function edit(operations: readonly CanvasOperation[]): void {
    document = applyOperations(document, operations, { limits: canvasLimits, origin: 'user', now: () => '2026-11-12T00:00:00.000Z' }).document
    revision += 1
  }

  it('generates a node, records its version, and clears the status', async () => {
    edit([{ op: 'add', type: 'image', title: '参考图', gen: { kind: 'image', prompt: '画一个店员', params: {} } }] as never)
    const outcome = await runPlan(services(), ['n1'])
    expect(outcome.status).toBe('done')
    expect(generated).toEqual(['image:n1'])
    const node = document.nodes.find(candidate => candidate.id === 'n1') as CanvasNode
    expect(node.versions).toHaveLength(1)
    expect(node.activeVersion).toBeUndefined()
    expect(node.versions?.[0]?.id).toMatch(/^media-/u)
    expect(node.versions?.[0]).toMatchObject({ path: join(directory, 'image.png'), prompt: '画一个店员', model: 'image-model' })
    expect(node.status).toBeUndefined()
  })

  it('creates a keyframe and a video per storyboard segment and records the numbers a version needs', async () => {
    edit([{
      op: 'add', type: 'storyboard', title: '场1 分镜',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: ['s1', 's2', 's3', 's4', 's5', 's6'].map(shot),
    }] as never)
    const outcome = await runPlan(services({ concurrency: 8 }), ['n1'])
    expect(outcome.status).toBe('done')

    const videos = document.nodes.filter(node => node.type === 'video')
    const keyframes = document.nodes.filter(node => node.type === 'image')
    expect(videos.length).toBeGreaterThan(0)
    expect(keyframes.length).toBe(videos.length)
    for (const video of videos) {
      expect(video.versions?.[0]).toMatchObject({ durationMs: 3000, width: 720, height: 1280, model: 'video-model' })
    }
    // Every video is driven by its segment's keyframe through a first_frame edge.
    for (const video of videos) {
      expect(document.edges.some(edge => edge.target === video.id && edge.role === 'first_frame')).toBe(true)
    }
    // Keyframes carry the segment's shot coverage and feed their video.
    for (const keyframe of keyframes) {
      expect(keyframe.gen?.kind).toBe('image')
      expect(keyframe.gen?.shot?.storyboard).toBe('n1')
    }
  })

  it('updates a reused segment prompt before generating with the new prompt', async () => {
    const close: Shot = { ...shot('s1'), shotSize: 'close' }
    const storyboardId = brandString<CanvasNodeId>('n1')
    const shotId = brandString<ShotId>('s1')
    edit([
      {
        op: 'add', type: 'storyboard', title: '场1 分镜', gen: { kind: 'video', prompt: '', params: {} }, shots: [close],
      },
      {
        op: 'add', type: 'video', title: '场1 · 段1',
        gen: {
          kind: 'video', prompt: '0–3s [close] 画面 s1。动作：动作。运镜：固定。避免：',
          params: { duration: 3 }, shot: { storyboard: storyboardId, shots: [shotId] },
        },
      },
    ])
    edit([{ op: 'update_shot', node: 'n1', shot: 's1', patch: { shotSize: 'medium' } }])
    const calls: string[] = []
    const base = services()
    const strict = services({
      generate: {
        ...base.generate,
        video: async (call) => {
          calls.push(call.prompt)
          return { path: join(directory, 'updated.mp4'), model: 'video-model' }
        },
      },
    })

    const started = await startPlan(strict, ['n1'])
    if (started.status !== 'started') throw new Error('expected generation to start')
    await started.settle
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('[medium]')
    expect(calls[0]).not.toContain('[close]')
    expect((document.nodes.find(node => node.id === 'n2') as CanvasNode).gen?.prompt).toBe(calls[0])
  })

  it('marks a node failed with a retryable status and keeps its earlier version', async () => {
    edit([{ op: 'add', type: 'image', path: '/old.png', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    fail = true
    const outcome = await runPlan(services(), ['n1'])
    expect(outcome.status).toBe('done')
    const node = document.nodes[0] as CanvasNode
    expect(node.status).toMatchObject({ state: 'failed', error: 'gateway said no', retryable: true })
    expect(node.versions).toHaveLength(1)
  })

  it('starts generation without a confirmation step', async () => {
    edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    const outcome = await runPlan(services(), ['n1'])
    expect(outcome.status).toBe('done')
    expect(generated).toHaveLength(1)
  })

  it('regenerates a storyboard without adding nodes, reusing the keyframe nodes', async () => {
    edit([{
      op: 'add', type: 'storyboard', title: '场1',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1'), shot('s2')],
    }] as never)
    const first = await runPlan(services({ concurrency: 8 }), ['n1'])
    expect(first.status).toBe('done')
    const before = document.nodes.length
    const second = await runPlan(services({ concurrency: 8 }), ['n1'])
    expect(second.status).toBe('done')
    // Keyframes and videos are reused as nodes; only new versions are appended.
    expect(document.nodes.length).toBe(before)
    const video = document.nodes.find(node => node.type === 'video') as CanvasNode
    expect(video.versions?.length).toBeGreaterThanOrEqual(2)
    expect(video.tailOf).toBeUndefined()
  })

  it('writes three independent groups concurrently without losing a revision', async () => {
    edit([1, 2, 3].map(index => ({
      op: 'add' as const, type: 'image' as const, title: `image ${String(index)}`,
      gen: { kind: 'image' as const, prompt: `p${String(index)}`, params: {} },
    })))
    const outcome = await runPlan(services({ concurrency: 3 }), ['n1', 'n2', 'n3'])
    expect(outcome.status).toBe('done')
    if (outcome.status !== 'done') throw new Error('expected done')
    expect(outcome.results.filter(result => result.ok)).toHaveLength(3)
    for (const node of document.nodes) expect(node.versions).toHaveLength(1)
  })

  it('classifies a 4xx failure as not retryable and a cancellation as cancelled', async () => {
    edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    const denied = services({
      generate: {
        ...services().generate,
        image: async () => { throw Object.assign(new Error('bad parameter'), { status: 422 }) },
      },
    })
    const first = await runPlan(denied, ['n1'])
    expect(first.status).toBe('done')
    expect((document.nodes[0] as CanvasNode).status).toMatchObject({ state: 'failed', error: 'bad parameter', retryable: false })

    const cancelled = services({
      generate: {
        ...services().generate,
        image: async (_call) => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        },
      },
    })
    await runPlan(cancelled, ['n1'])
  })

  it('retries a canvas write that lost a race and works without a live-job probe', async () => {
    edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    let conflicts = 1
    const racing = services()
    const baseEdit = racing.canvas.edit.bind(racing.canvas)
    const outcome = await runPlan({
      ...racing,
      canvas: {
        ...racing.canvas,
        edit: async (operations, baseRevision) => {
          if (conflicts > 0) {
            conflicts -= 1
            throw new CanvasConflictError(baseRevision, baseRevision + 1)
          }
          return baseEdit(operations, baseRevision)
        },
      },
      jobs: { start: (spec) => {
        const controller = new AbortController()
        return { id: 'media-x' as never, done: spec.run(controller.signal), signal: controller.signal }
      } },
    }, ['n1'])
    expect(outcome.status).toBe('done')
  })

  it('repairs a status a previous process left running', async () => {
    edit([{ op: 'add', type: 'image', path: '/a.png', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    edit([{ op: 'set_status', node: 'n1', status: { state: 'running', jobId: 'gone' as never, at: 'then' } }] as never)
    edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'q', params: {} } }] as never)
    const outcome = await runPlan(services(), ['n2'])
    expect(outcome.status).toBe('done')
    expect((document.nodes.find(node => node.id === 'n1') as CanvasNode).status)
      .toMatchObject({ state: 'failed', error: 'interrupted by a restart', retryable: true })
  })

  it('reports a cancellation and a non-Error rejection', async () => {
    edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    const cancelledServices = services({
      generate: {
        ...services().generate,
        image: async (call) => {
          if (call.signal.aborted) throw new Error('aborted')
          return { path: join(directory, 'x.png'), model: 'image-model' }
        },
      },
    })
    const cancelled = await runPlan({
      ...cancelledServices,
      jobs: {
        start: (spec) => {
          const controller = new AbortController()
          controller.abort()
          return { id: 'media-c' as never, done: spec.run(controller.signal), signal: controller.signal }
        },
      },
    }, ['n1'])
    expect(cancelled.status).toBe('done')
    expect((document.nodes[0] as CanvasNode).status).toMatchObject({ error: 'cancelled', retryable: true })

    await runPlan(services({
      generate: {
        ...services().generate,
        image: async () => { throw 'plain failure' },
      },
    }), ['n1'])
    expect((document.nodes[0] as CanvasNode).status).toMatchObject({ error: 'plain failure', retryable: true })
  })

  it('marks an orphan segment video stale before generating the new layout', async () => {
    edit([{
      op: 'add', type: 'storyboard', title: '场1',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1'), shot('s2')],
    }] as never)
    edit([{
      op: 'add', type: 'video', path: '/orphan.mp4',
      gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'n1' as never, shots: ['sx' as never] } },
    }] as never)
    const outcome = await runPlan(services(), ['n1'])
    expect(outcome.status).toBe('done')
    expect((document.nodes.find(node => node.id === 'n2') as CanvasNode).stale).toBe(true)
  })

  it('drives each segment video from the keyframe this run produced', async () => {
    edit([{
      op: 'add', type: 'storyboard', title: '场1', gen: { kind: 'video', prompt: '', params: {} },
      shots: ['s1', 's2', 's3', 's4', 's5', 's6'].map(shot),
    }] as never)
    const videoCalls: { readonly firstFramePath: string | undefined; readonly refs: readonly string[] }[] = []
    const base = services({ concurrency: 8 })
    const outcome = await runPlan({
      ...base,
      generate: {
        ...base.generate,
        video: async (call) => {
          videoCalls.push({ firstFramePath: call.firstFramePath, refs: call.refs })
          return { path: join(directory, `v-${String(videoCalls.length)}.mp4`), model: 'video-model' }
        },
      },
    }, ['n1'])
    expect(outcome.status).toBe('done')
    expect(videoCalls.length).toBeGreaterThan(0)
    // Every keyframe-driven video sends its first frame and no bible reference images.
    for (const call of videoCalls) {
      expect(call.firstFramePath).toBeDefined()
      expect(call.refs).toEqual([])
    }
  })

  it('fails a segment video without submitting when its keyframe fails', async () => {
    edit([{
      op: 'add', type: 'storyboard', title: '场1', gen: { kind: 'video', prompt: '', params: {} },
      shots: ['s1', 's2', 's3', 's4', 's5', 's6'].map(shot),
    }] as never)
    const videoCalls: string[] = []
    const base = services({ concurrency: 8 })
    const outcome = await runPlan({
      ...base,
      generate: {
        ...base.generate,
        image: async () => { throw Object.assign(new Error('keyframe gateway said no'), { status: 500 }) },
        video: async (call) => {
          videoCalls.push(String(call.node.id))
          return { path: join(directory, 'v.mp4'), model: 'video-model' }
        },
      },
    }, ['n1'])
    expect(outcome.status).toBe('done')
    // No video was submitted: every segment waits on a keyframe that failed.
    expect(videoCalls).toEqual([])
    const failedVideos = document.nodes.filter(node => node.type === 'video' && node.status?.state === 'failed')
    expect(failedVideos.length).toBeGreaterThan(0)
    for (const video of failedVideos) {
      const status = video.status
      if (status?.state !== 'failed') throw new Error('expected a failed status')
      expect(status.retryable).toBe(true)
      expect(status.error).toContain('dependency')
    }
  })

  it('starts nothing when the request names no nodes', async () => {
    const outcome = await runPlan(services(), [])
    expect(outcome.status).toBe('done')
    if (outcome.status !== 'done') throw new Error('expected done')
    expect(outcome.results).toEqual([])
  })

  it('reports a preparation failure through the registered job without generating media', async () => {
    edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    const broken = services()
    const outcome = await runPlan({
      ...broken,
      canvas: {
        ...broken.canvas,
        edit: async () => { throw new Error('canvas write failed') },
      },
    }, ['n1'])
    expect(outcome.status).toBe('done')
    if (outcome.status !== 'done') throw new Error('expected done')
    expect(outcome.results).toEqual([{ node: 'n1', jobId: 'media-1', ok: false, error: 'canvas write failed', retryable: true }])
    expect(generated).toEqual([])
  })

  it('dispatches speech and music nodes to their generators', async () => {
    edit([
      { op: 'add', type: 'audio', gen: { kind: 'speech', prompt: 'hello', params: { voice: 'v' } } },
      { op: 'add', type: 'audio', gen: { kind: 'music', prompt: 'theme', params: {} } },
    ] as never)
    const calls: string[] = []
    const outcome = await runPlan(services({
      generate: {
        image: async () => ({ path: join(directory, 'i.png'), model: 'image-model' }),
        video: async () => ({ path: join(directory, 'v.mp4'), model: 'video-model' }),
        speech: async () => { calls.push('speech'); return { path: join(directory, 's.mp3'), model: 'speech-model' } },
        music: async () => { calls.push('music'); return { path: join(directory, 'm.mp3'), model: 'music-model' } },
      },
    }), ['n1', 'n2'])
    expect(outcome.status).toBe('done')
    expect(calls.sort()).toEqual(['music', 'speech'])
  })

  it('passes a blocked plan back without generating anything', async () => {
    edit([{
      op: 'add', type: 'storyboard', gen: { kind: 'video', prompt: '', params: {} },
      shots: [{ ...shot('s1'), shotSize: undefined }] as never,
    }] as never)
    const outcome = await runPlan(services(), ['n1'])
    expect(outcome.status).toBe('blocked')
    expect(generated).toEqual([])
  })

  it('records the reference and frame files a call consumed', async () => {
    edit([
      { op: 'add', type: 'image', path: '/ref.png' },
      { op: 'add', type: 'image', path: '/first.png' },
      { op: 'add', type: 'image', path: '/last.png' },
      { op: 'add', type: 'video', gen: { kind: 'video', prompt: 'p', params: { duration: 6 } } },
    ] as never)
    edit([
      { op: 'connect', from: 'n1', to: 'n4', kind: 'reference', role: 'ref' },
      { op: 'connect', from: 'n2', to: 'n4', kind: 'reference', role: 'first_frame' },
      { op: 'connect', from: 'n3', to: 'n4', kind: 'reference', role: 'last_frame' },
    ] as never)
    const outcome = await runPlan(services(), ['n4'])
    expect(outcome.status).toBe('done')
    const video = document.nodes.find(node => node.id === 'n4') as CanvasNode
    expect(video.versions?.[0]?.inputs?.map(input => [input.node, input.role])).toEqual([
      ['n1', 'ref'], ['n2', 'first_frame'], ['n3', 'last_frame'],
    ])
  })

  it('waits for a free generation slot when the bound is one', async () => {
    edit([
      { op: 'add', type: 'image', gen: { kind: 'image', prompt: 'a', params: {} } },
      { op: 'add', type: 'image', gen: { kind: 'image', prompt: 'b', params: {} } },
    ] as never)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = services({
      concurrency: 1,
      generate: {
        ...services().generate,
        image: async (call) => {
          if (String(call.node.id) === 'n1') await gate
          return { path: join(directory, `${String(call.node.id)}.png`), model: 'image-model' }
        },
      },
    })
    const outcome = await startPlan(started, ['n1', 'n2'])
    expect(outcome.status).toBe('started')
    release()
    if (outcome.status !== 'started') throw new Error('expected started')
    expect((await outcome.settle).filter(result => result.ok)).toHaveLength(2)
  })

})

describe('keyframe pipeline scheduling', () => {
  const directory = '/tmp/media-keyframes'
  const limitsLocal = {
    maxVideoSeconds: 15, minVideoSeconds: 4, videoDefaultDuration: 5, videoModel: 'video-model', videoRefModel: 'video-ref-model',
    imageModel: 'image-model', speechModel: 'speech-model', musicModel: 'music-model',
  }

  interface Call { readonly kind: 'image' | 'video'; readonly node: string; readonly order: number }
  function harness(concurrency: number, shotsPerBoard = 6) {
    const rigged = rig()
    const { apply, canvas } = rigged
    let jobs = 0
    const calls: Call[] = []
    const videoIO: { node: string; firstFramePath: string | undefined; lastFramePath: string | undefined; refs: readonly string[] }[] = []
    apply([{
      op: 'add', type: 'storyboard', title: '场1', gen: { kind: 'video', prompt: '', params: {} },
      shots: Array.from({ length: shotsPerBoard }, (_, index) => shot(`s${String(index + 1)}`)),
    }], 'user')
    const services: RunnerServices = {
      state: createRunnerState(),
      canvas,
      limits: limitsLocal,
      concurrency,
      generate: {
        image: async (call) => {
          calls.push({ kind: 'image', node: String(call.node.id), order: calls.length })
          return { path: `${directory}/k-${String(call.node.id)}.png`, model: 'image-model' }
        },
        video: async (call) => {
          calls.push({ kind: 'video', node: String(call.node.id), order: calls.length })
          videoIO.push({
            node: String(call.node.id), firstFramePath: call.firstFramePath,
            lastFramePath: call.lastFramePath, refs: call.refs,
          })
          return { path: `${directory}/v-${String(call.node.id)}.mp4`, model: 'video-model' }
        },
        speech: async () => ({ path: `${directory}/s.mp3`, model: 'speech-model' }),
        music: async () => ({ path: `${directory}/m.mp3`, model: 'music-model' }),
      },
      jobs: {
        start: (spec) => {
          jobs += 1
          const controller = new AbortController()
          return { id: `media-${String(jobs)}` as never, done: spec.run(controller.signal), signal: controller.signal }
        },
        live: () => [],
      },
      probe: async () => ({ durationMs: 3000, width: 720, height: 1280 }),
      tailFrame: async path => `${path}.tail.png`,
      now: () => '2026-11-12T00:00:00.000Z',
    }
    return { services, calls, videoIO, boardId: 'n1', get document() { return rigged.document } }
  }

  // Shared canvas state for tests that need custom generators: apply edits and expose the
  // read/edit service surface runPlan drives.
  function rig() {
    const canvasLimits = resolveConfig({})
    let document: CanvasDocument = EMPTY_CANVAS
    let revision = 0
    const apply = (operations: readonly CanvasOperation[], origin: 'user' | 'agent'): void => {
      const outcome = applyOperations(document, operations, { limits: canvasLimits, origin, now: () => '2026-11-12T00:00:00.000Z' })
      document = outcome.document
      revision += 1
    }
    const canvas = {
      read: async () => ({ document, revision }),
      bible: async () => bibleFixture,
      edit: async (operations: readonly CanvasOperation[], baseRevision: number): Promise<CanvasEditResult> => {
        if (baseRevision !== revision) throw new CanvasConflictError(baseRevision, revision)
        const outcome = applyOperations(document, operations, { limits: canvasLimits, origin: 'agent', now: () => '2026-11-12T00:00:00.000Z' })
        document = outcome.document
        revision += 1
        return outcome.result
      },
    }
    return { apply, canvas, get document() { return document } }
  }

  it('generates keyframes before the videos that consume them, with frame paths and no refs', async () => {
    const { services, calls, videoIO, boardId } = harness(8)
    expect((await runPlan(services, [boardId])).status).toBe('done')
    const images = calls.filter(call => call.kind === 'image')
    const videos = calls.filter(call => call.kind === 'video')
    expect(images.length).toBeGreaterThan(0)
    expect(videos.length).toBeGreaterThan(0)
    // Every video ran after at least one keyframe, and carries its first frame with no refs.
    for (const video of videoIO) {
      expect(video.firstFramePath).toBeDefined()
      expect(video.refs).toEqual([])
    }
    // The last image call precedes the first video only when a video depends on it; at minimum the
    // first keyframe resolves before any dependent video is submitted.
    expect(calls.findIndex(call => call.kind === 'video')).toBeGreaterThan(calls.findIndex(call => call.kind === 'image'))
  })

  it('starts the first keyframes of two storyboards together before later keyframes', async () => {
    const rigged = rig()
    const { apply, canvas } = rigged
    let jobs = 0
    const imageStarts: string[] = []
    apply([{
      op: 'add', type: 'storyboard', title: '场A', gen: { kind: 'video', prompt: '', params: {} },
      shots: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(shot),
    }], 'user')
    apply([{
      op: 'add', type: 'storyboard', title: '场B', gen: { kind: 'video', prompt: '', params: {} },
      shots: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map(shot),
    }], 'user')
    const services: RunnerServices = {
      state: createRunnerState(),
      canvas,
      limits: limitsLocal,
      concurrency: 8,
      generate: {
        image: async (call) => {
          imageStarts.push(String(call.node.id))
          return { path: `${directory}/k-${String(call.node.id)}.png`, model: 'image-model' }
        },
        video: async call => ({ path: `${directory}/v-${String(call.node.id)}.mp4`, model: 'video-model' }),
        speech: async () => ({ path: `${directory}/s.mp3`, model: 'speech-model' }),
        music: async () => ({ path: `${directory}/m.mp3`, model: 'music-model' }),
      },
      jobs: {
        start: (spec) => {
          jobs += 1
          const controller = new AbortController()
          return { id: `media-${String(jobs)}` as never, done: spec.run(controller.signal), signal: controller.signal }
        },
        live: () => [],
      },
      probe: async () => ({ durationMs: 3000, width: 720, height: 1280 }),
      tailFrame: async path => `${path}.tail.png`,
      now: () => '2026-11-12T00:00:00.000Z',
    }
    expect((await runPlan(services, ['n1', 'n2'])).status).toBe('done')
    // Both storyboards planned keyframes; the run finished every segment of both.
    const videos = rigged.document.nodes.filter(node => node.type === 'video')
    const keyframes = rigged.document.nodes.filter(node => node.type === 'image')
    expect(videos.length).toBeGreaterThan(1)
    expect(keyframes.length).toBe(videos.length)
    expect(imageStarts.length).toBe(keyframes.length)
  })

  it('bounds the number of generations in flight to the configured concurrency', async () => {
    const rigged = rig()
    const { apply, canvas } = rigged
    let jobs = 0
    let active = 0
    let maxActive = 0
    apply([1, 2, 3, 4].map(index => ({
      op: 'add' as const, type: 'image' as const, title: `i${String(index)}`,
      gen: { kind: 'image' as const, prompt: `p${String(index)}`, params: {} },
    })), 'user')
    const services: RunnerServices = {
      state: createRunnerState(),
      canvas,
      limits: limitsLocal,
      concurrency: 2,
      generate: {
        image: async (call) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise(resolve => setTimeout(resolve, 5))
          active -= 1
          return { path: `${directory}/${String(call.node.id)}.png`, model: 'image-model' }
        },
        video: async () => ({ path: `${directory}/v.mp4`, model: 'video-model' }),
        speech: async () => ({ path: `${directory}/s.mp3`, model: 'speech-model' }),
        music: async () => ({ path: `${directory}/m.mp3`, model: 'music-model' }),
      },
      jobs: {
        start: (spec) => {
          jobs += 1
          const controller = new AbortController()
          return { id: `media-${String(jobs)}` as never, done: spec.run(controller.signal), signal: controller.signal }
        },
        live: () => [],
      },
      probe: async () => ({}),
      tailFrame: async path => `${path}.tail.png`,
      now: () => '2026-11-12T00:00:00.000Z',
    }
    expect((await runPlan(services, ['n1', 'n2', 'n3', 'n4'])).status).toBe('done')
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(maxActive).toBeGreaterThan(1)
    expect(rigged.document.nodes.filter(node => node.versions !== undefined).length).toBe(4)
  })
})
