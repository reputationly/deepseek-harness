import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { fingerprint } from '../src/pending.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)])
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(13)])

interface DirectUserProjectionState {
  textHash: string | null
}

type DirectUserProjectionEvent = {
  type: string
  data?: { source?: { kind?: string }; content?: { type: string; text?: string }[] }
}

interface DirectUserProjectionDefinition {
  init: () => DirectUserProjectionState
  apply: (state: DirectUserProjectionState, event: DirectUserProjectionEvent) => DirectUserProjectionState
}

const none = { min: 0, max: 0 }
const mode = (id: string, taskType: string, image: number, single?: string) => ({
  id, label: { zh: id, en: id }, taskType, ...single !== undefined ? { taskTypeIfSingleImage: single } : {},
  references: { image: { min: 0, max: image }, video: none, audio: none },
})
const VIDEO_PARAMS = {
  ratio: { type: 'string', title: '比例', enum: ['adaptive', '16:9', '9:16'], default: 'adaptive' },
  resolution: { type: 'string', title: '分辨率', enum: ['768P', '2K'], default: '2K' },
  duration: { type: 'string', title: '时长', enum: Array.from({ length: 20 }, (_, index) => String(index + 1)), default: '5' },
  generate_audio: { type: 'string', title: '声音', enum: ['true', 'false'], default: 'true' },
  image_mode: { type: 'string', title: '玩法', enum: ['text-to-video', 'first-last-frame'] },
}
const video = (model: string, modes: unknown[]) => ({
  id: `generate_video:${model}`, operation: 'generate_video', model,
  displayName: { zh: model, en: model }, description: { zh: '', en: '' }, transport: { kind: 'videos_task' },
  paramSchema: { type: 'object', properties: VIDEO_PARAMS },
  limits: { maxReferenceImages: 9, maxDurationSeconds: 20, maxInputBytes: 0 }, modes, default: false,
})
const FL = video('minimax-h3-2k', [mode('text-to-video', 't2v', 0), mode('first-last-frame', 'flf2v', 2, 'i2v')])
const REF = video('minimax-h3-ref-2k', [mode('reference', 'r2va', 9)])
const EXT = video('minimax-h3-ext', [mode('video-extension', 'continuation', 0)])
const SPEECH = {
  id: 'generate_speech:minimax-speech', operation: 'generate_speech', model: 'minimax-speech',
  displayName: { zh: 'Speech', en: 'Speech' }, description: { zh: '', en: '' }, transport: { kind: 'audio_speech' },
  paramSchema: { type: 'object', properties: { voice: { type: 'string', title: '音色', enum: ['female-1', 'male-1'] } }, required: ['voice'] },
}

const MUSIC = {
  id: 'generate_music:minimax-music3', operation: 'generate_music', model: 'minimax-music3',
  displayName: { zh: 'Music 3.0', en: 'Music 3.0' }, description: { zh: '', en: '' }, transport: { kind: 'videos_task' },
  paramSchema: {
    type: 'object',
    properties: {
      is_instrumental: { type: 'string', title: '纯音乐', enum: ['true', 'false'], default: 'false' },
      lyrics: { type: 'string', title: '歌词' },
    },
  },
  limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 }, default: true,
}

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Boot the tools over stubbed catalog, task, question, and workspace services. */
async function boot(options: {
  answer?: (request: AskUserQuestionRequest) => AskUserQuestionAnswer
  wait?: () => Promise<unknown>
  save?: (path: string, cwd: string) => Promise<void>
  review?: string
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'suanli-media-video-'))
  dirs.push(cwd)
  const ask = vi.fn(async (request: AskUserQuestionRequest) => options.answer?.(request) ?? { answers: [] })
  const submit = vi.fn(async (_request: Record<string, unknown>) => ({ ok: true as const, taskId: 't1', transport: 'videos' as const, state: 'running' as const }))
  const wait = vi.fn(options.wait ?? (async () => ({ ok: true, status: { taskId: 't1', state: 'succeeded', url: 'https://cdn.example/v' } })))
  const cancel = vi.fn(async () => ({ ok: true }))
  const inspect = vi.fn(async () => ({ ok: true as const, text: options.review ?? '' }))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('suanliModels', {
    preferences: () => ({ autoReview: options.review !== undefined }),
    roles: () => [
      { role: 'vision', candidates: [{ model: 'vl', label: 'VL' }], selected: null, fallback: 'vl' },
      { role: 'speech', candidates: [{ model: 'minimax-speech', label: 'Speech' }], selected: null, fallback: 'minimax-speech' },
      { role: 'video', candidates: [{ model: FL.model, label: 'MiniMax H3' }, { model: REF.model, label: 'MiniMax H3 Ref' }], selected: null, fallback: FL.model },
      { role: 'music', candidates: [{ model: MUSIC.model, label: 'Music 3.0' }], selected: null, fallback: MUSIC.model },
    ],
    media: () => ({ status: 'ready', version: '1', fetchedAt: 1, entries: [FL, REF, EXT, MUSIC, SPEECH] }),
  } as never)
  ctx.provide('suanliMedia', {
    submit, wait, cancel,
    speak: vi.fn(async (_request: unknown, path: string) => {
      await options.save?.(path, cwd)
      await writeFile(path, MP3)
      return { ok: true as const, path, bytes: MP3.byteLength }
    }),
    inspect,
    saveArtifact: async (url: string, path: string) => {
      await options.save?.(path, cwd)
      await writeFile(path, url.endsWith('/m') ? MP3 : MP4)
      return { ok: true as const, path, bytes: MP4.byteLength }
    },
  } as never)
  ctx.provide('userQuestions', { ask } as never)
  const pendingRecords = new Map<string, Record<string, unknown>>()
  const artifactRecords = new Map<string, Record<string, unknown>>()
  ctx.provide('storageDomain', {
    open: async () => ({
      table: (name: string) => name === 'artifacts' ? {
        entries: () => artifactRecords.entries(),
        put: async (key: string, value: Record<string, unknown>) => { artifactRecords.set(key, value) },
      } : {
        get: (key: string) => pendingRecords.get(key),
        entries: () => pendingRecords.entries(),
        put: async (key: string, value: Record<string, unknown>) => { pendingRecords.set(key, value) },
        delete: async (key: string) => pendingRecords.delete(key),
      },
    }),
  } as never)
  const directUserTexts = new Map<string, string>()
  let directUserProjection: DirectUserProjectionDefinition | undefined
  const projectDirectUserEvent = (state: DirectUserProjectionState, event: DirectUserProjectionEvent): DirectUserProjectionState => {
    if (directUserProjection === undefined) throw new Error('projection was not registered')
    return directUserProjection.apply(state, event)
  }
  ctx.provide('sessionProjections', {
    register: async (definition: DirectUserProjectionDefinition) => {
      directUserProjection = definition
      const stateOf = (session: { id: string }): DirectUserProjectionState => {
        const text = directUserTexts.get(session.id)
        const initial = definition.init()
        return text === undefined ? initial : definition.apply(initial, {
          type: 'user/message',
          data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
        })
      }
      return {
        stateOf,
        readerFor: (session: { id: string }) => () => stateOf(session),
        dispose: async () => {},
      }
    },
  } as never)
  ctx.provide('workingDirectory', { ensure: async () => cwd } as never)
  ctx.provide('fs', {
    resolve: async (path: string, opts: { cwd: string }) => ({ targetKey: resolve(opts.cwd, path), displayPath: resolve(opts.cwd, path) }),
    readBytes: async (target: { displayPath: string }) => new Uint8Array(await readFile(target.displayPath)),
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(plugin)
  const run = async (
    name: string, args: Record<string, unknown>, signal = new AbortController().signal, session = 's1', userText = '用户原始请求',
  ) => {
    directUserTexts.set(session, userText)
    return await executeToolFixture(ctx, {
      callId: ToolCallId('c1'), name, arguments: args,
      agent: { id: 'a1', session: { id: session } } as unknown as Agent,
      signal,
    })
  }
  return { ctx, cwd, ask, submit, wait, cancel, inspect, run, pendingRecords, projectDirectUserEvent }
}

/** Text of one result. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

describe('generation guidance', () => {
  it('tells the model not to substitute local tools for unavailable or failed cloud generation', async () => {
    const { ctx } = await boot()
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('Never substitute local operating-system speech synthesis')
  })

  it('projects only non-empty direct user text into the resume identity hash', async () => {
    const { projectDirectUserEvent } = await boot()
    const existing = { textHash: 'kept' }
    expect(projectDirectUserEvent(existing, { type: 'turn/end' })).toBe(existing)
    expect(projectDirectUserEvent(existing, {
      type: 'user/message', data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: '注入上下文' }] },
    })).toBe(existing)
    expect(projectDirectUserEvent(existing, {
      type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '  ' }] },
    })).toBe(existing)
    const direct = projectDirectUserEvent({ textHash: null }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'image' }, { type: 'text', text: '直接请求' }] },
    })
    expect(direct.textHash).toMatch(/^[0-9a-f]{64}$/u)
  })
})

describe('generate_video', () => {
  it('asks only for what a 10-second portrait request leaves open, and saves an mp4', async () => {
    const { ask, submit, run, cwd } = await boot({
      answer: () => ({ answers: [{ id: 'resolution', selected: ['768P'] }, { id: 'generate_audio', selected: ['无声'] }] }),
    })
    const result = await run('generate_video', { prompt: '海边日落', aspect_ratio: '竖屏', duration_seconds: 10 })
    expect(result.isError).toBe(false)
    const questions = ask.mock.calls[0]?.[0].questions ?? []
    expect(questions.map(item => item.id)).toEqual(['resolution', 'generate_audio'])
    expect(questions[1]?.options?.map(option => option.label)).toEqual(['有声', '无声'])
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'generate_video', model: 'minimax-h3-2k', taskType: 't2v',
      params: { ratio: '9:16', resolution: '768P', duration: '10', generate_audio: 'false', image_mode: 'text-to-video' },
    }))
    expect((await readdir(join(cwd, 'generated')))[0]).toMatch(/\.mp4$/u)
  })

  it('names the longest duration when the request is too long', async () => {
    const { ask, run } = await boot()
    await run('generate_video', { prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', with_audio: true, duration_seconds: 30 })
    const question = ask.mock.calls[0]?.[0].questions[0]
    expect(question?.question).toContain('当前不支持「30」')
    expect(question?.detail).toContain('最长 20')
    expect(question?.options?.length).toBeLessThanOrEqual(6)
  })

  it('turns one first frame into an image-to-video task', async () => {
    const { submit, run, cwd } = await boot()
    await writeFile(join(cwd, 'cat.png'), PNG)
    await run('generate_video', { prompt: '猫跳起来', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true, first_frame: 'cat.png' })
    const request = submit.mock.calls[0]?.[0] as { referenceImages?: readonly string[] } | undefined
    expect(request).toMatchObject({ model: 'minimax-h3-2k', taskType: 'i2v', params: { image_mode: 'first-last-frame' } })
    expect(request?.referenceImages?.[0]).toMatch(/^data:image\/png;base64,/u)
  })

  it('moves reference images to the model that offers a reference mode', async () => {
    const { submit, run, cwd } = await boot()
    for (const name of ['a.png', 'b.png', 'c.png']) await writeFile(join(cwd, name), PNG)
    await run('generate_video', {
      prompt: '三人同框', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true, reference_images: ['a.png', 'b.png', 'c.png'],
    })
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ model: 'minimax-h3-ref-2k', taskType: 'r2va' }))
    expect(submit.mock.calls[0]?.[0].referenceImages).toHaveLength(3)
  })

  it('continues a workspace clip on the model that offers continuation', async () => {
    const { submit, run, cwd } = await boot()
    await writeFile(join(cwd, 'clip.mp4'), MP4)
    await run('generate_video', {
      prompt: '接着跑', aspect_ratio: '16:9', resolution: '768P', duration_seconds: 10, with_audio: true, source_video: 'clip.mp4',
    })
    const request = submit.mock.calls[0]?.[0] as { model?: string; taskType?: string; sourceVideo?: string } | undefined
    expect(request).toMatchObject({ model: 'minimax-h3-ext', taskType: 'continuation', params: { resolution: '768P' } })
    expect(request?.sourceVideo).toMatch(/^data:video\/mp4;base64,/u)
  })

  it('continues a previously generated clip by gateway task reference', async () => {
    const { submit, run, cwd } = await boot()
    await run('generate_video', { prompt: '小猫玩耍', aspect_ratio: '16:9', resolution: '768P', duration_seconds: 5, with_audio: true })
    const [file] = await readdir(join(cwd, 'generated'))
    await run('generate_video', {
      prompt: '接着跑', aspect_ratio: '16:9', resolution: '768P', duration_seconds: 10, with_audio: true, source_video: `generated/${file}`,
    })
    const request = submit.mock.calls[1]?.[0] as { sourceVideo?: string } | undefined
    expect(request?.sourceVideo).toBe('task:t1')
  })

  it('uploads a replaced clip instead of continuing the old task', async () => {
    const { submit, run, cwd } = await boot()
    await run('generate_video', { prompt: '小猫玩耍', aspect_ratio: '16:9', resolution: '768P', duration_seconds: 5, with_audio: true })
    const [file] = await readdir(join(cwd, 'generated'))
    await writeFile(join(cwd, 'generated', file), Buffer.concat([MP4, Buffer.from([1])]))
    await run('generate_video', {
      prompt: '接着跑', aspect_ratio: '16:9', resolution: '768P', duration_seconds: 10, with_audio: true, source_video: `generated/${file}`,
    })
    const request = submit.mock.calls[1]?.[0] as { sourceVideo?: string } | undefined
    expect(request?.sourceVideo).toMatch(/^data:video\/mp4;base64,/u)
  })

  it('offers only 768P for a continued clip', async () => {
    const { ask, run, cwd } = await boot()
    await writeFile(join(cwd, 'clip.mp4'), MP4)
    await run('generate_video', {
      prompt: '接着跑', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 10, with_audio: true, source_video: 'clip.mp4',
    })
    const question = ask.mock.calls[0]?.[0].questions[0]
    expect(question?.question).toContain('当前不支持「2K」')
    expect(question?.options?.map(option => option.label)).toEqual(['768P'])
  })

  it('refuses a continued clip that also carries images', async () => {
    const { submit, run, cwd } = await boot()
    await writeFile(join(cwd, 'clip.mp4'), MP4)
    await writeFile(join(cwd, 'cat.png'), PNG)
    const result = await run('generate_video', { prompt: '接着跑', source_video: 'clip.mp4', first_frame: 'cat.png' })
    expect(textOf(result)).toBe('Error: A continued clip takes no images.')
    expect(submit).not.toHaveBeenCalled()
  })

  it('cancels the gateway task when the call stops', async () => {
    const controller = new AbortController()
    const { cancel, run } = await boot({
      wait: async () => {
        controller.abort()
        return { ok: false, reason: 'timed-out' }
      },
    })
    const result = await run('generate_video', {
      prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true,
    }, controller.signal)
    expect(result.isError).toBe(true)
    expect(cancel).toHaveBeenCalledWith('t1', 'generate_video')
  })

  it('resumes an unsettled task instead of submitting it again, and submits anew once it delivered', async () => {
    const { submit, wait, run } = await boot()
    const args = { prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true }
    wait.mockRejectedValueOnce(new Error('the Host went away'))
    expect((await run('generate_video', args)).isError).toBe(true)
    const resumed = await run('generate_video', args)
    expect(resumed.isError).toBe(false)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(wait).toHaveBeenLastCalledWith('t1', 'generate_video', expect.any(Number))
    await run('generate_video', args)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('resumes a pending task when the model mildly rewords the same video request', async () => {
    const { submit, wait, run } = await boot()
    const first = { prompt: '一只毛茸茸的小猫在柔软的毯子上玩耍，伸出前爪扑向一个毛线球，活泼可爱，画面明亮温馨，特写镜头，自然光', aspect_ratio: '16:9', resolution: '768P', duration_seconds: 1, with_audio: false }
    const reworded = { ...first, prompt: '一只毛茸茸的橘白小猫在柔软的米色毯子上玩耍，伸爪扑向一个彩色毛线球，动作活泼，特写镜头，明亮温馨的自然光，柔和的景深' }
    wait.mockRejectedValueOnce(new Error('the Host went away'))
    expect((await run('generate_video', first)).isError).toBe(true)
    expect((await run('generate_video', reworded)).isError).toBe(false)
    expect(submit).toHaveBeenCalledTimes(1)
    await run('generate_video', reworded)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('does not attach a different video request to a pending task', async () => {
    const { submit, wait, run } = await boot()
    const first = { prompt: '一只毛茸茸的小猫在柔软的毯子上玩耍，伸出前爪扑向一个毛线球，活泼可爱，画面明亮温馨，特写镜头，自然光', aspect_ratio: '16:9', resolution: '768P', duration_seconds: 1, with_audio: false }
    const different = { ...first, prompt: '一只小狗在公园里追飞盘，画面明亮，特写镜头，自然光' }
    wait.mockRejectedValueOnce(new Error('the Host went away'))
    expect((await run('generate_video', first)).isError).toBe(true)
    await run('generate_video', different)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('does not resume a reworded prompt after the user changes the request', async () => {
    const { submit, wait, run } = await boot()
    const first = { prompt: '一只毛茸茸的小猫在柔软的毯子上玩耍，伸出前爪扑向一个毛线球，活泼可爱，画面明亮温馨，特写镜头，自然光', aspect_ratio: '16:9', resolution: '768P', duration_seconds: 1, with_audio: false }
    const reworded = { ...first, prompt: '一只毛茸茸的橘白小猫在柔软的米色毯子上玩耍，伸爪扑向一个彩色毛线球，动作活泼，特写镜头，明亮温馨的自然光，柔和的景深' }
    wait.mockRejectedValueOnce(new Error('the Host went away'))
    expect((await run('generate_video', first)).isError).toBe(true)
    await run('generate_video', reworded, new AbortController().signal, 's1', '改成另一个视频')
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('submits anew after the call stopped its task', async () => {
    const controller = new AbortController()
    const { submit, wait, run } = await boot()
    wait.mockImplementationOnce(async () => {
      controller.abort()
      return { ok: false, reason: 'timed-out' }
    })
    const args = { prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true }
    await run('generate_video', args, controller.signal)
    await run('generate_video', args)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('leaves the task rendering and resumable when the Host shuts down mid-call', async () => {
    const controller = new AbortController()
    const { submit, wait, cancel, run } = await boot()
    wait.mockImplementationOnce(async () => {
      controller.abort({ kind: 'disposed' })
      return { ok: false, reason: 'timed-out' }
    })
    const args = { prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true }
    await run('generate_video', args, controller.signal)
    expect(cancel).not.toHaveBeenCalled()
    expect((await run('generate_video', args)).isError).toBe(false)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('stops waiting at once when the call stops mid-poll', async () => {
    const controller = new AbortController()
    const { wait, run } = await boot()
    wait.mockImplementationOnce(async () => {
      setTimeout(() => { controller.abort({ kind: 'disposed' }) }, 10)
      return await new Promise(() => {})
    })
    const args = { prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true }
    expect((await run('generate_video', args, controller.signal)).isError).toBe(true)
  })

  it('never attaches another chat to this chat\'s task', async () => {
    const { submit, wait, run } = await boot()
    const args = { prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true }
    wait.mockRejectedValueOnce(new Error('the Host went away'))
    await run('generate_video', args)
    await run('generate_video', args, new AbortController().signal, 's2')
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('never publishes outside the workspace when generated/ is replaced during rendering', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'suanli-media-outside-'))
    dirs.push(outside)
    const { run } = await boot({
      save: async (_path, cwd) => {
        await rm(join(cwd, 'generated'), { recursive: true })
        await symlink(outside, join(cwd, 'generated'))
      },
    })
    const result = await run('generate_video', { prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('outside the workspace')
    expect(await readdir(outside)).toEqual([])
  })
})

describe('requirement review', () => {
  it('records the vision model verdict in the result', async () => {
    const { inspect, run } = await boot({ review: '```json\n{"verdict":"mismatch","reason":"画面里没有海"}\n```' })
    const result = await run('generate_video', { prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true })
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ media: [{ kind: 'video', url: 'https://cdn.example/v' }] }))
    expect(result.meta).toMatchObject({ review: { verdict: 'mismatch', reason: '画面里没有海' } })
    expect(JSON.parse(textOf(result))).toMatchObject({ review: { verdict: 'mismatch' } })
  })

  it('leaves the result unreviewed when review is off', async () => {
    const { run } = await boot()
    const result = await run('generate_video', { prompt: '海边日落', aspect_ratio: '16:9', resolution: '2K', duration_seconds: 5, with_audio: true })
    expect(result.meta).not.toHaveProperty('review')
  })
})

describe('generate_music', () => {
  it('resumes a pre-upgrade pending song recorded before instructions joined the fingerprint', async () => {
    const { cwd, pendingRecords, submit, run } = await boot()
    const request = {
      operation: 'generate_music' as const,
      model: 'minimax-music3',
      prompt: '轻快的钢琴曲',
      params: { is_instrumental: 'false' },
    }
    pendingRecords.set(fingerprint('s1', cwd, request), { taskId: 't1', submittedAt: Date.now() })
    const result = await run('generate_music', { prompt: '轻快的钢琴曲', instrumental: false })
    expect(result.isError).toBe(false)
    expect(submit).not.toHaveBeenCalled()
  })

  it('asks whether the piece is instrumental and saves an mp3', async () => {
    const { ask, submit, run, wait, cwd } = await boot({ answer: () => ({ answers: [{ id: 'is_instrumental', selected: ['纯音乐'] }] }) })
    wait.mockResolvedValue({ ok: true, status: { taskId: 't1', state: 'succeeded', url: 'https://cdn.example/m' } })
    const result = await run('generate_music', { prompt: '轻快的钢琴曲' })
    expect(result.isError).toBe(false)
    expect(ask.mock.calls[0]?.[0].questions[0]?.options?.map(option => option.label)).toEqual(['带人声', '纯音乐'])
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'generate_music', params: { is_instrumental: 'true', instructions: '轻快的钢琴曲' } }))
    expect((await readdir(join(cwd, 'generated')))[0]).toMatch(/\.mp3$/u)
  })
})

describe('generate_music lyrics', () => {
  it('drops the lyrics when the user chooses an instrumental piece', async () => {
    const { submit, run, wait } = await boot({ answer: () => ({ answers: [{ id: 'is_instrumental', selected: ['纯音乐'] }] }) })
    wait.mockResolvedValue({ ok: true, status: { taskId: 't1', state: 'succeeded', url: 'https://cdn.example/m' } })
    await run('generate_music', { prompt: '轻快的钢琴曲', lyrics: '啦啦啦' })
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ params: { is_instrumental: 'true', instructions: '轻快的钢琴曲' } }))
  })
})

describe('generate_speech', () => {
  it('asks the voice the catalog requires and saves the audio', async () => {
    const { ask, run, cwd } = await boot({ answer: () => ({ answers: [{ id: 'voice', selected: ['male-1'] }] }) })
    const result = await run('generate_speech', { text: '你好，欢迎使用蒜狸小助手' })
    expect(result.isError).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.meta).toMatchObject({ status: 'generated', model: 'minimax-speech', parameters: { voice: 'male-1' } })
    expect((await readdir(join(cwd, 'generated')))[0]).toMatch(/\.mp3$/u)
  })
})
