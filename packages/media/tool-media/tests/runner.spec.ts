import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Bible, CanvasDocument, CanvasEditResult, CanvasNode, CanvasOperation, Shot } from '@deepseek-ai/dsh-canvas'
import { EMPTY_CANVAS } from '@deepseek-ai/dsh-canvas/src/document.ts'
import { resolveConfig } from '@deepseek-ai/dsh-canvas/src/config.ts'
import { applyOperations } from '@deepseek-ai/dsh-canvas/src/operations.ts'
import { runPlan, type MediaGenerator, type RunnerServices } from '../src/runner.ts'

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
        if (baseRevision !== revision) throw new Error(`stale revision ${String(baseRevision)}`)
        const outcome = applyOperations(document, operations, { limits: canvasLimits, origin: 'agent', now: () => '2026-11-12T00:00:00.000Z' })
        document = outcome.document
        revision += 1
        return outcome.result
      },
    }
    const generator: MediaGenerator = {
      image: async (call) => {
        if (fail) throw new Error('gateway said no')
        generated.push(`image:${call.node.id}`)
        return { path: join(directory, 'image.png'), model: 'image-model' }
      },
      video: async (call) => {
        if (fail) throw new Error('gateway said no')
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
          return { id: `media-${String(jobs)}`, done: spec.run(controller.signal) }
        },
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

  it('passes a blocked plan back without generating anything', async () => {
    await edit([{
      op: 'add', type: 'storyboard', gen: { kind: 'video', prompt: '', params: {} },
      shots: [{ ...shot('s1'), shotSize: undefined }] as never,
    }] as never)
    const outcome = await runPlan(services(), ['n1'], undefined)
    expect(outcome.status).toBe('blocked')
    expect(generated).toEqual([])
  })
})
