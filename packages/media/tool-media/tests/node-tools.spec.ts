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
      canvas: ctx.get('canvas') as CanvasService,
      limits,
      confirmLimits,
      concurrency: 1,
      generate: generator,
      jobs: () => ({
        start: spec => ({ id: `media-${String(generated.length)}`, done: spec.run(new AbortController().signal) }),
      }),
      probe: async () => ({ durationMs: 3000, width: 720, height: 1280 }),
      tailFrame: async () => join(directory, 'tail.png'),
    })
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

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

  it('generates a node through the tool and reports what it produced', async () => {
    await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: '画店员', params: {} } }] as never)
    const result = await call('canvas_generate', { nodeIds: ['n1'] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Generated 1 node')
    expect(generated).toEqual(['image:n1'])
    const document = await (ctx.get('canvas') as CanvasService).read(session)
    const node = document.nodes[0] as CanvasNode
    expect(node.versions?.[0]?.path).toBe(join(directory, 'image.png'))
  })

  it('voices every line of a storyboard', async () => {
    await edit([{
      op: 'add', type: 'storyboard', title: '场1',
      gen: { kind: 'video', prompt: '', params: {} },
      shots: [shot('s1', [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: '欢迎光临' }]), shot('s2')],
    }] as never)
    const result = await call('storyboard_voice', { storyboards: ['n1'] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Generated 1 node')
    expect(generated).toEqual(['speech:欢迎光临'])
    const document = await (ctx.get('canvas') as CanvasService).read(session)
    const audio = document.nodes.filter(node => node.type === 'audio')
    expect(audio).toHaveLength(1)
    expect(audio[0]?.gen?.dialogue?.line).toBe('d1')
  })
})
