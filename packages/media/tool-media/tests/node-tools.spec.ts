import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CanvasService, { type CanvasNode, type Shot } from '@deepseek-ai/dsh-canvas'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerNodeTools } from '../src/node-tools.ts'
import type { MediaGenerator } from '../src/runner.ts'

const limits = {
  maxVideoSeconds: 15, videoDefaultDuration: 5, videoModel: 'video-model', videoRefModel: 'video-ref-model',
  imageModel: 'image-model', speechModel: 'speech-model', musicModel: 'music-model',
}

const confirmLimits = {
  confirmVideoCalls: 5, confirmVideoSeconds: 60, confirmSpeechLines: 50, confirmImageCalls: 50, confirmMusicCalls: 5,
}

const shot = (id: string, dialogue: Shot['dialogue'] = []): Shot => ({
  id: id as never, title: id, shotSize: 'medium', visual: `画面 ${id}`, motion: '动作', camera: '固定', durationSec: 3,
  characters: [], props: [], dialogue, sfx: '', negative: '',
})

describe('generation tools', () => {
  let directory: string
  let ctx: Context
  let session: Session
  let generated: string[]
  let liveJobs: string[]

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-node-tools-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    provideWorkingDirectoryFixture(ctx, directory)
    await ctx.plugin(CanvasService)
    session = Session.create(SessionId('node-tools-session'))
    generated = []
    liveJobs = []
    const generator: MediaGenerator = {
      image: async (call) => {
        generated.push(`image:${call.node.id}`)
        return { path: join(directory, 'image.png'), model: 'image-model' }
      },
      video: async () => ({ path: join(directory, 'video.mp4'), model: 'video-model' }),
      speech: async (call) => {
        generated.push(`speech:${call.prompt}`)
        return { path: join(directory, 'speech.mp3'), model: 'speech-model' }
      },
      music: async () => ({ path: join(directory, 'music.mp3'), model: 'music-model' }),
    }
    registerNodeTools(ctx, {
      canvas: () => ctx.get('canvas') as CanvasService | undefined,
      limits,
      confirmLimits,
      concurrency: 1,
      generate: generator,
      jobs: () => ({
        start: (spec) => {
          const controller = new AbortController()
          return { id: `media-${String(generated.length)}` as never, done: spec.run(controller.signal), signal: controller.signal }
        },
        live: () => liveJobs,
      }),
      probe: async () => ({ durationMs: 3000, width: 720, height: 1280 }),
      tailFrame: async () => join(directory, 'tail.png'),
    })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
  })

  async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await predicate()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('timed out waiting for the generation to finish')
  }

  async function call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId(`call-${name}`),
      name,
      arguments: args,
      agent: { id: session.id, session } as never,
    })
    return { text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''), isError: result.isError }
  }

  async function edit(operations: readonly never[]): Promise<void> {
    const service = ctx.get('canvas') as CanvasService
    await service.edit(session, operations, { baseRevision: (await service.read(session)).revision })
  }

  it('starts a generation job and reports it immediately', async () => {
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: '画店员', params: {} } }] as never)
    const result = await call('canvas_generate', { nodes: ['n1'] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Started 1 generation job')
    expect(generated).toEqual(['image:n1'])
    await waitFor(async () => (await (ctx.get('canvas') as CanvasService).read(session)).nodes[0]?.versions?.length === 1)
    const node = (await (ctx.get('canvas') as CanvasService).read(session)).nodes[0] as CanvasNode
    expect(node.versions?.[0]?.path).toBe(join(directory, 'image.png'))
  })

  it('asks for confirmation through the tool when the plan crosses a threshold', async () => {
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    const ctxStrict = new Context()
    await ctxStrict.plugin(SystemPrompt)
    await ctxStrict.plugin(ToolRuntime)
    await ctxStrict.plugin(NativeToolExecutor)
    provideWorkingDirectoryFixture(ctxStrict, directory)
    await ctxStrict.plugin(CanvasService)
    registerNodeTools(ctxStrict, {
      canvas: () => ctxStrict.get('canvas') as CanvasService | undefined,
      limits,
      confirmLimits: { ...confirmLimits, confirmImageCalls: 1, confirmSpeechLines: 1 },
      concurrency: 1,
      generate: {
        image: async () => ({ path: join(directory, 'image.png'), model: 'image-model' }),
        video: async () => ({ path: join(directory, 'video.mp4'), model: 'video-model' }),
        speech: async () => ({ path: join(directory, 'speech.mp3'), model: 'speech-model' }),
        music: async () => ({ path: join(directory, 'music.mp3'), model: 'music-model' }),
      },
      jobs: () => ({
        start: (spec) => {
          const controller = new AbortController()
          return { id: 'media-1' as never, done: spec.run(controller.signal), signal: controller.signal }
        },
        live: () => [],
      }),
      probe: async () => ({ durationMs: 3000, width: 720, height: 1280 }),
      tailFrame: async () => join(directory, 'tail.png'),
    })
    const service = ctxStrict.get('canvas') as CanvasService
    service.edit(session, [{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never, { baseRevision: 0 })
      .catch(() => undefined)
    const result = await executeToolFixture(ctxStrict, {
      signal: new AbortController().signal,
      callId: ToolCallId('call-confirm'),
      name: 'canvas_generate',
      arguments: { nodes: ['n1'] },
      agent: { id: session.id, session } as never,
    })
    const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(text).toContain('needs confirmation')
    expect(text).toContain('confirmToken ')

    const board = await service.edit(session, [{
      op: 'add', type: 'storyboard', title: '场1', gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1', [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: '你好' }])],
    }] as never, { baseRevision: (await service.read(session)).revision })
    void board
    const voice = await executeToolFixture(ctxStrict, {
      signal: new AbortController().signal,
      callId: ToolCallId('call-voice-confirm'),
      name: 'storyboard_voice',
      arguments: { storyboards: ['n2'] },
      agent: { id: session.id, session } as never,
    })
    const voiceText = voice.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(voiceText).toContain('needs confirmation')
  })

  it('reports a storyboard gate as blocked', async () => {
    await edit([{
      op: 'add', type: 'storyboard', gen: { kind: 'video', prompt: '', params: {} },
      shots: [{ ...shot('s1'), characters: ['ghost' as never] }] as never,
    }] as never)
    const result = await call('canvas_generate', { nodes: ['n1'] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Generation blocked (G2_storyboard_quality)')
    expect(result.text).toContain('bible entry ghost')
  })

  it('refuses a node whose job is still running', async () => {
    liveJobs = ['media-1']
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    await edit([{ op: 'set_status', node: 'n1', status: { state: 'running', jobId: 'media-1', at: 'now' } }] as never)
    const result = await call('canvas_generate', { nodes: ['n1'] })
    expect(result.text).toContain('already have a generation job')
    expect(generated).toEqual([])
  })

  it('voices every line of a storyboard', async () => {
    await edit([{
      op: 'add', type: 'storyboard', title: '场1',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1', [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: '欢迎光临' }]), shot('s2')],
    }] as never)
    const result = await call('storyboard_voice', { storyboards: ['n1'] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Started 1 generation job')
    expect(generated).toEqual(['speech:欢迎光临'])
    await waitFor(async () => (await (ctx.get('canvas') as CanvasService).read(session)).nodes
      .filter(node => node.type === 'audio').every(node => (node.versions ?? []).length > 0))
    const document = await (ctx.get('canvas') as CanvasService).read(session)
    const audio = document.nodes.filter(node => node.type === 'audio')
    expect(audio).toHaveLength(1)
    expect(audio[0]?.gen?.dialogue?.line).toBe('d1')
  })

  it('reuses a node that already voices the line and skips creating anything', async () => {
    await edit([{
      op: 'add', type: 'storyboard', title: '场1',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1', [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: '欢迎光临' }])],
    }] as never)
    await call('storyboard_voice', { storyboards: ['n1'] })
    await waitFor(async () => (await (ctx.get('canvas') as CanvasService).read(session)).nodes
      .filter(node => node.type === 'audio').every(node => (node.versions ?? []).length > 0))
    generated = []
    const again = await call('storyboard_voice', { storyboards: ['n1'] })
    expect(again.isError).toBe(false)
    expect(again.text).toContain('Started 1 generation job')
    expect(generated).toEqual(['speech:欢迎光临'])
  })

  it('reports a storyboard id that does not exist', async () => {
    const result = await call('storyboard_voice', { storyboards: ['n404'] })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('node n404 does not exist')
  })

  it('reports a reused node whose job is already running', async () => {
    await edit([{
      op: 'add', type: 'storyboard', title: '场1',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1', [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: '欢迎光临' }])],
    }] as never)
    await call('storyboard_voice', { storyboards: ['n1'] })
    await waitFor(async () => (await (ctx.get('canvas') as CanvasService).read(session)).nodes
      .filter(node => node.type === 'audio').every(node => (node.versions ?? []).length > 0))
    const audio = (await (ctx.get('canvas') as CanvasService).read(session)).nodes.find(node => node.type === 'audio')
    liveJobs = ['media-1']
    await edit([{ op: 'set_status', node: String(audio?.id), status: { state: 'running', jobId: 'media-1', at: 'now' } }] as never)
    const again = await call('storyboard_voice', { storyboards: ['n1'] })
    expect(again.text).toContain('already have a generation job')
  })

  it('reads the project spec when the project exists', async () => {
    const service = ctx.get('canvas') as CanvasService
    await service.createProject(session, { format: 'drama', title: '测试', spec: { aspect: '9:16', resolution: '1080p', fps: 30 } })
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'p', params: {} } }] as never)
    const result = await call('canvas_generate', { nodes: ['n1'] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Started 1 generation job')
  })
})
