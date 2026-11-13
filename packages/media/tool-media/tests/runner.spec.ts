import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CanvasConflictError, type Bible, type CanvasDocument, type CanvasEditResult, type CanvasNode, type CanvasNodeId, type CanvasOperation, type Shot, type ShotId } from '@deepseek-ai/dsh-canvas'
import { EMPTY_CANVAS } from '@deepseek-ai/dsh-canvas/src/document.ts'
import { resolveConfig } from '@deepseek-ai/dsh-canvas/src/config.ts'
import { applyOperations } from '@deepseek-ai/dsh-canvas/src/operations.ts'
import { runPlan, startPlan, type MediaGenerator, type RunnerServices } from '../src/runner.ts'

const limits = {
  maxVideoSeconds: 15, videoDefaultDuration: 5, videoModel: 'video-model', videoRefModel: 'video-ref-model',
  imageModel: 'image-model', speechModel: 'speech-model', musicModel: 'music-model',
}

const confirmLimits = {
  confirmVideoCalls: 5, confirmVideoSeconds: 60, confirmSpeechLines: 50, confirmImageCalls: 50, confirmMusicCalls: 5,
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
    version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' }, entries: [],
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
      canvas,
      limits,
      confirmLimits,
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
    await edit([{ op: 'add', type: 'image', title: '参考图', gen: { kind: 'image', prompt: '画一个店员', params: {} } }] as never)
    const outcome = await runPlan(services(), ['n1'], undefined)
    expect(outcome.status).toBe('done')
    expect(generated).toEqual(['image:n1'])
    const node = document.nodes.find(candidate => candidate.id === 'n1') as CanvasNode
    expect(node.versions).toHaveLength(1)
    expect(node.activeVersion).toBe('v1')
    expect(node.versions?.[0]).toMatchObject({ path: join(directory, 'image.png'), prompt: '画一个店员', model: 'image-model' })
    expect(node.status).toBeUndefined()
  })

  it('creates the video segments of a storyboard, chains their tails, and records the numbers a version needs', async () => {
    await edit([{
      op: 'add', type: 'storyboard', title: '场1 分镜',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: ['s1', 's2', 's3', 's4', 's5', 's6'].map(shot),
    }] as never)
    const outcome = await runPlan(services({ concurrency: 1 }), ['n1'], undefined)
    expect(outcome.status).toBe('done')
    expect(generated).toHaveLength(2)
    expect(generated[1]).toContain('tail.png')

    const videos = document.nodes.filter(node => node.type === 'video')
    expect(videos).toHaveLength(2)
    for (const video of videos) {
      expect(video.versions?.[0]).toMatchObject({ durationMs: 3000, width: 720, height: 1280, model: 'video-model' })
    }
    const second = videos.find(video => video.gen?.shot?.shots.length === 5) as CanvasNode
    expect(document.edges.some(edge => edge.target === second.id && edge.role === 'first_frame')).toBe(true)
  })

  it('confirms a reused segment prompt update before applying it and generates with the new prompt', async () => {
    const close: Shot = { ...shot('s1'), shotSize: 'close' }
    const storyboardId = brandString<CanvasNodeId>('n1')
    const shotId = brandString<ShotId>('s1')
    await edit([
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
    const oldPrompt = (document.nodes.find(node => node.id === 'n2') as CanvasNode).gen?.prompt
    const calls: string[] = []
    const base = services()
    const strict = services({
      confirmLimits: { ...confirmLimits, confirmVideoCalls: 1 },
      generate: {
        ...base.generate,
        video: async (call) => {
          calls.push(call.prompt)
          return { path: join(directory, 'updated.mp4'), model: 'video-model' }
        },
      },
    })

    const initial = await startPlan(strict, ['n1'], undefined)
    if (initial.status !== 'needs_confirmation') throw new Error('expected initial confirmation')
    await edit([{ op: 'update_shot', node: 'n1', shot: 's1', patch: { shotSize: 'medium' } }])
    const outdated = await startPlan(strict, ['n1'], initial.budget.token)
    if (outdated.status !== 'needs_confirmation') throw new Error('expected updated confirmation')
    expect(outdated.budget.token).not.toBe(initial.budget.token)
    expect((document.nodes.find(node => node.id === 'n2') as CanvasNode).gen?.prompt).toBe(oldPrompt)

    const started = await startPlan(strict, ['n1'], outdated.budget.token)
    if (started.status !== 'started') throw new Error('expected generation to start')
    await started.settle
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('[medium]')
    expect(calls[0]).not.toContain('[close]')
    expect((document.nodes.find(node => node.id === 'n2') as CanvasNode).gen?.prompt).toBe(calls[0])
  })

  it('marks a node failed with a retryable status and keeps its earlier version', async () => {
    await edit([{ op: 'add', type: 'image', path: '/old.png', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    fail = true
    const outcome = await runPlan(services(), ['n1'], undefined)
    expect(outcome.status).toBe('done')
    const node = document.nodes[0] as CanvasNode
    expect(node.status).toMatchObject({ state: 'failed', error: 'gateway said no', retryable: true })
    expect(node.versions).toHaveLength(1)
  })

  it('asks for confirmation when the plan crosses a threshold, then runs with the same token', async () => {
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    const strict = services({ confirmLimits: { ...confirmLimits, confirmImageCalls: 1 } })
    const asked = await runPlan(strict, ['n1'], undefined)
    expect(asked.status).toBe('needs_confirmation')
    if (asked.status !== 'needs_confirmation') throw new Error('expected a question')
    expect(asked.budget.token).toHaveLength(16)
    expect(generated).toEqual([])
    expect((await runPlan(strict, ['n1'], asked.budget.token)).status).toBe('done')
  })

  it('regenerates a video without adding nodes, refreshing its tail frame', async () => {
    await edit([{
      op: 'add', type: 'storyboard', title: '场1',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1'), shot('s2')],
    }] as never)
    const first = await runPlan(services({ concurrency: 1 }), ['n1'], undefined)
    expect(first.status).toBe('done')
    const before = document.nodes.length
    const second = await runPlan(services({ concurrency: 1 }), ['n1'], undefined)
    expect(second.status).toBe('done')
    expect(document.nodes.length).toBe(before)
    const video = document.nodes.find(node => node.type === 'video') as CanvasNode
    expect(video.versions).toHaveLength(2)
    expect(video.tailOf?.node).toBe(document.nodes.find(node => node.type === 'image')?.id)
  })

  it('writes three independent groups concurrently without losing a revision', async () => {
    await edit([1, 2, 3].map(index => ({
      op: 'add' as const, type: 'image' as const, title: `image ${String(index)}`,
      gen: { kind: 'image' as const, prompt: `p${String(index)}`, params: {} },
    })))
    const outcome = await runPlan(services({ concurrency: 3 }), ['n1', 'n2', 'n3'], undefined)
    expect(outcome.status).toBe('done')
    if (outcome.status !== 'done') throw new Error('expected done')
    expect(outcome.results.filter(result => result.ok)).toHaveLength(3)
    for (const node of document.nodes) expect(node.versions).toHaveLength(1)
  })

  it('classifies a 4xx failure as not retryable and a cancellation as cancelled', async () => {
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    const denied = services({
      generate: {
        ...services().generate,
        image: async () => { throw Object.assign(new Error('bad parameter'), { status: 422 }) },
      },
    })
    const first = await runPlan(denied, ['n1'], undefined)
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
    await runPlan(cancelled, ['n1'], undefined, { skipConfirmation: true })
  })

  it('retries a canvas write that lost a race and works without a live-job probe', async () => {
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    let conflicts = 1
    const racing = services()
    const baseEdit = racing.canvas.edit
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
    }, ['n1'], undefined)
    expect(outcome.status).toBe('done')
  })

  it('repairs a status a previous process left running', async () => {
    await edit([{ op: 'add', type: 'image', path: '/a.png', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    await edit([{ op: 'set_status', node: 'n1', status: { state: 'running', jobId: 'gone' as never, at: 'then' } }] as never)
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'q', params: {} } }] as never)
    const outcome = await runPlan(services(), ['n2'], undefined)
    expect(outcome.status).toBe('done')
    expect((document.nodes.find(node => node.id === 'n1') as CanvasNode).status)
      .toMatchObject({ state: 'failed', error: 'interrupted by a restart', retryable: true })
  })

  it('reports a cancellation and a non-Error rejection', async () => {
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
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
    }, ['n1'], undefined)
    expect(cancelled.status).toBe('done')
    expect((document.nodes[0] as CanvasNode).status).toMatchObject({ error: 'cancelled', retryable: true })

    await runPlan(services({
      generate: {
        ...services().generate,
        image: async () => { throw 'plain failure' },
      },
    }), ['n1'], undefined, { skipConfirmation: true })
    expect((document.nodes[0] as CanvasNode).status).toMatchObject({ error: 'plain failure', retryable: true })
  })

  it('marks an orphan segment video stale before generating the new layout', async () => {
    await edit([{
      op: 'add', type: 'storyboard', title: '场1',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1'), shot('s2')],
    }] as never)
    await edit([{
      op: 'add', type: 'video', path: '/orphan.mp4',
      gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'n1' as never, shots: ['sx' as never] } },
    }] as never)
    const outcome = await runPlan(services(), ['n1'], undefined)
    expect(outcome.status).toBe('done')
    expect((document.nodes.find(node => node.id === 'n2') as CanvasNode).stale).toBe(true)
  })

  it('uses a tail frame an earlier run recorded for the next segment', async () => {
    await edit([{
      op: 'add', type: 'storyboard', title: '场1', gen: { kind: 'video', prompt: '', params: {} },
      shots: ['s1', 's2', 's3', 's4', 's5', 's6'].map(shot),
    }] as never)
    await edit([{ op: 'add', type: 'image', path: '/tail.png' }] as never)
    await edit([{
      op: 'add', type: 'video', path: '/first.mp4',
      gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'n1' as never, shots: ['s1' as never] } },
    }] as never)
    await edit([{ op: 'set_tail', node: 'n3', tailOf: { node: 'n2' as never, version: 'v1' as never } }] as never)
    const outcome = await runPlan(services({ concurrency: 1 }), ['n1'], undefined)
    expect(outcome.status).toBe('done')
    expect(generated.some(call => call.includes('tail.png'))).toBe(true)
  })

  it('records a generation whose tail extraction fails as failed', async () => {
    await edit([{
      op: 'add', type: 'storyboard', title: '场1', gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1'), shot('s2')],
    }] as never)
    const broken = services()
    const outcome = await runPlan({
      ...broken,
      tailFrame: async () => { throw new Error('ffmpeg failed') },
    }, ['n1'], undefined)
    expect(outcome.status).toBe('done')
    const video = document.nodes.find(node => node.type === 'video') as CanvasNode
    expect(video.status).toMatchObject({ state: 'failed', error: 'ffmpeg failed', retryable: true })
    expect(video.versions).toHaveLength(1)
  })

  it('starts nothing when the request names no nodes', async () => {
    const outcome = await runPlan(services(), [], undefined)
    expect(outcome.status).toBe('done')
    if (outcome.status !== 'done') throw new Error('expected done')
    expect(outcome.results).toEqual([])
  })

  it('reports a preparation failure without starting a job', async () => {
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    const broken = services()
    const outcome = await runPlan({
      ...broken,
      canvas: {
        ...broken.canvas,
        edit: async () => { throw new Error('canvas write failed') },
      },
    }, ['n1'], undefined)
    expect(outcome.status).toBe('done')
    if (outcome.status !== 'done') throw new Error('expected done')
    expect(outcome.results).toEqual([{ node: 'n1', ok: false, error: 'canvas write failed', retryable: true }])
  })

  it('dispatches speech and music nodes to their generators', async () => {
    await edit([
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
    }), ['n1', 'n2'], undefined)
    expect(outcome.status).toBe('done')
    expect(calls.sort()).toEqual(['music', 'speech'])
  })

  it('passes a blocked plan back without generating anything', async () => {
    await edit([{
      op: 'add', type: 'storyboard', gen: { kind: 'video', prompt: '', params: {} },
      shots: [{ ...shot('s1'), shotSize: undefined }] as never,
    }] as never)
    const outcome = await runPlan(services(), ['n1'], undefined)
    expect(outcome.status).toBe('blocked')
    expect(generated).toEqual([])
  })

  it('records the reference and frame files a call consumed', async () => {
    await edit([
      { op: 'add', type: 'image', path: '/ref.png' },
      { op: 'add', type: 'image', path: '/first.png' },
      { op: 'add', type: 'image', path: '/last.png' },
      { op: 'add', type: 'video', gen: { kind: 'video', prompt: 'p', params: { duration: 6 } } },
    ] as never)
    await edit([
      { op: 'connect', from: 'n1', to: 'n4', kind: 'reference', role: 'ref' },
      { op: 'connect', from: 'n2', to: 'n4', kind: 'reference', role: 'first_frame' },
      { op: 'connect', from: 'n3', to: 'n4', kind: 'reference', role: 'last_frame' },
    ] as never)
    const outcome = await runPlan(services(), ['n4'], undefined)
    expect(outcome.status).toBe('done')
    const video = document.nodes.find(node => node.id === 'n4') as CanvasNode
    expect(video.versions?.[0]?.inputs?.map(input => [input.node, input.role])).toEqual([
      ['n1', 'ref'], ['n2', 'first_frame'], ['n3', 'last_frame'],
    ])
  })

  it('waits for a free generation slot when the bound is one', async () => {
    await edit([
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
    const outcome = await startPlan(started, ['n1', 'n2'], undefined, { skipConfirmation: true })
    expect(outcome.status).toBe('started')
    release()
    if (outcome.status !== 'started') throw new Error('expected started')
    expect((await outcome.settle).filter(result => result.ok)).toHaveLength(2)
  })

})

describe('segment regeneration', () => {
  it('regenerates both segments from the latest tail, reconnects the frame, and clears input changes', async () => {
    const directory = '/tmp/media-runner'
    const limitsLocal = {
      maxVideoSeconds: 15, videoDefaultDuration: 5, videoModel: 'video-model', videoRefModel: 'video-ref-model',
      imageModel: 'image-model', speechModel: 'speech-model', musicModel: 'music-model',
    }
    const confirmLimitsLocal = {
      confirmVideoCalls: 9, confirmVideoSeconds: 90, confirmSpeechLines: 50, confirmImageCalls: 50, confirmMusicCalls: 5,
    }
    const canvasLimits = resolveConfig({})
    let document: CanvasDocument = EMPTY_CANVAS
    let revision = 0
    let jobs = 0
    let videoNumber = 0
    const videoCalls: { readonly node: string; readonly firstFramePath: string | undefined }[] = []
    const edit = (operations: readonly CanvasOperation[], origin: 'user' | 'agent' = 'user'): CanvasEditResult => {
      const outcome = applyOperations(document, operations, { limits: canvasLimits, origin, now: () => '2026-11-12T00:00:00.000Z' })
      document = outcome.document
      revision += 1
      return outcome.result
    }
    edit([{
      op: 'add', type: 'storyboard', title: '场1', gen: { kind: 'video', prompt: '', params: {} },
      shots: ['s1', 's2', 's3', 's4', 's5', 's6'].map(shot),
    }])
    const services: RunnerServices = {
      canvas: {
        read: async () => ({ document, revision }),
        bible: async () => undefined,
        edit: async (operations, baseRevision) => {
          if (baseRevision !== revision) throw new CanvasConflictError(baseRevision, revision)
          return edit(operations, 'agent')
        },
      },
      limits: limitsLocal,
      confirmLimits: confirmLimitsLocal,
      concurrency: 1,
      generate: {
        image: async () => ({ path: `${directory}/tail.png`, model: 'image-model' }),
        video: async (call) => {
          videoNumber += 1
          videoCalls.push({ node: String(call.node.id), firstFramePath: call.firstFramePath })
          return { path: `${directory}/video-${String(videoNumber)}.mp4`, model: 'video-model' }
        },
        speech: async () => ({ path: `${directory}/speech.mp3`, model: 'speech-model' }),
        music: async () => ({ path: `${directory}/music.mp3`, model: 'music-model' }),
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
    expect((await runPlan(services, ['n1'], undefined)).status).toBe('done')
    const first = document.nodes.find(node => node.type === 'video' && node.gen?.shot?.shots.length === 1) as CanvasNode
    const second = document.nodes.find(node => node.type === 'video' && node.gen?.shot?.shots.length === 5) as CanvasNode
    expect(first.tailOf?.version).toBe('v1')
    expect(videoCalls[1]?.firstFramePath).toBe(`${directory}/video-1.mp4.tail.png`)
    const tailNode = first.tailOf?.node
    if (tailNode === undefined) throw new Error('expected the first segment tail')
    edit([
      { op: 'set_input_changed', node: first.id, changed: true },
      { op: 'set_input_changed', node: second.id, changed: true },
      { op: 'disconnect', from: tailNode, to: second.id, role: 'first_frame' },
    ])
    expect((await runPlan(services, ['n1'], undefined)).status).toBe('done')
    const refreshed = document.nodes.find(node => node.id === first.id) as CanvasNode
    expect(refreshed.tailOf?.version).toBe('v2')
    expect(videoCalls[3]?.firstFramePath).toBe(`${directory}/video-3.mp4.tail.png`)
    expect(document.edges.some(edge => edge.source === tailNode && edge.target === second.id
      && edge.kind === 'reference' && edge.role === 'first_frame')).toBe(true)
    expect(refreshed.inputChanged).toBeUndefined()
    expect((document.nodes.find(node => node.id === second.id) as CanvasNode).inputChanged).toBeUndefined()
  })
})
