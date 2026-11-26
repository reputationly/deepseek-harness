import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12)])
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(13)])

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
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'suanli-media-video-'))
  dirs.push(cwd)
  const ask = vi.fn(async (request: AskUserQuestionRequest) => options.answer?.(request) ?? { answers: [] })
  const submit = vi.fn(async (_request: Record<string, unknown>) => ({ ok: true as const, taskId: 't1', transport: 'videos' as const, state: 'running' as const }))
  const wait = vi.fn(options.wait ?? (async () => ({ ok: true, status: { taskId: 't1', state: 'succeeded', url: 'https://cdn.example/v' } })))
  const cancel = vi.fn(async () => ({ ok: true }))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('suanliModels', {
    roles: () => [
      { role: 'video', candidates: [{ model: FL.model, label: 'MiniMax H3' }, { model: REF.model, label: 'MiniMax H3 Ref' }], selected: null, fallback: FL.model },
      { role: 'music', candidates: [{ model: MUSIC.model, label: 'Music 3.0' }], selected: null, fallback: MUSIC.model },
    ],
    media: () => ({ status: 'ready', version: '1', fetchedAt: 1, entries: [FL, REF, MUSIC] }),
  } as never)
  ctx.provide('suanliMedia', {
    submit, wait, cancel,
    saveArtifact: async (url: string, path: string) => {
      await options.save?.(path, cwd)
      await writeFile(path, url.endsWith('/m') ? MP3 : MP4)
      return { ok: true as const, path, bytes: MP4.byteLength }
    },
  } as never)
  ctx.provide('userQuestions', { ask } as never)
  ctx.provide('workingDirectory', { ensure: async () => cwd } as never)
  ctx.provide('fs', {
    resolve: async (path: string, opts: { cwd: string }) => ({ path: resolve(opts.cwd, path) }),
    readBytes: async (target: { path: string }) => new Uint8Array(await readFile(target.path)),
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin)
  const run = async (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => await executeToolFixture(ctx, {
    callId: ToolCallId('c1'), name, arguments: args, agent: { id: 'a1' } as unknown as Agent, signal,
  })
  return { ctx, cwd, ask, submit, wait, cancel, run }
}

/** Text of one result. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

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
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      model: 'minimax-h3-2k', taskType: 'i2v', referenceImages: [expect.stringMatching(/^data:image\/png;base64,/u)],
      params: expect.objectContaining({ image_mode: 'first-last-frame' }),
    }))
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

describe('generate_music', () => {
  it('asks whether the piece is instrumental and saves an mp3', async () => {
    const { ask, submit, run, wait, cwd } = await boot({ answer: () => ({ answers: [{ id: 'is_instrumental', selected: ['纯音乐'] }] }) })
    wait.mockResolvedValue({ ok: true, status: { taskId: 't1', state: 'succeeded', url: 'https://cdn.example/m' } })
    const result = await run('generate_music', { prompt: '轻快的钢琴曲' })
    expect(result.isError).toBe(false)
    expect(ask.mock.calls[0]?.[0].questions[0]?.options?.map(option => option.label)).toEqual(['带人声', '纯音乐'])
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'generate_music', params: { is_instrumental: 'true' } }))
    expect((await readdir(join(cwd, 'generated')))[0]).toMatch(/\.mp3$/u)
  })
})
