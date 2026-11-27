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

const ENTRY = {
  id: 'generate_image:minimax-h3-image', operation: 'generate_image', model: 'minimax-h3-image',
  displayName: { zh: 'MiniMax H3 Image', en: 'MiniMax H3 Image' }, description: { zh: '', en: '' },
  transport: { kind: 'images' },
  paramSchema: {
    type: 'object',
    properties: {
      aspect_ratio: { type: 'string', title: '宽高比', enum: ['adaptive', '1:1', '16:9', '9:16'], default: 'adaptive' },
      resolution: { type: 'string', title: '分辨率', enum: ['1K', '2K'], default: '2K' },
    },
  },
  limits: { maxReferenceImages: 4, maxDurationSeconds: 0, maxInputBytes: 0 },
  default: true,
}

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Boot the tool over stubbed catalog, task, question, and workspace services. */
async function boot(options: { answer?: (request: AskUserQuestionRequest) => AskUserQuestionAnswer; candidates?: boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'suanli-media-tools-'))
  dirs.push(cwd)
  let candidates = options.candidates ?? true
  const ask = vi.fn(async (request: AskUserQuestionRequest) => options.answer?.(request) ?? { answers: [] })
  const submit = vi.fn(async () => ({ ok: true as const, taskId: 't1', transport: 'images' as const, state: 'succeeded' as const, url: 'https://cdn.example/a' }))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('suanliModels', {
    preferences: () => ({ autoReview: false }),
    roles: () => [{
      role: 'image',
      candidates: candidates ? [{ model: 'minimax-h3-image', label: 'MiniMax H3 Image' }] : [],
      selected: null,
      fallback: candidates ? 'minimax-h3-image' : null,
    }],
    media: () => ({ status: 'ready', version: '1', fetchedAt: 1, entries: candidates ? [ENTRY] : [] }),
  } as never)
  ctx.provide('suanliMedia', {
    submit,
    wait: vi.fn(),
    saveArtifact: async (_url: string, path: string) => {
      await writeFile(path, PNG)
      return { ok: true as const, path, bytes: PNG.byteLength }
    },
  } as never)
  ctx.provide('userQuestions', { ask } as never)
  ctx.provide('sessionProjections', {
    register: async () => ({
      stateOf: () => ({ textHash: null }),
      readerFor: () => () => ({ textHash: null }),
      dispose: async () => {},
    }),
  } as never)
  ctx.provide('workingDirectory', { ensure: async () => cwd } as never)
  ctx.provide('fs', {
    resolve: async (path: string, opts: { cwd: string }) => ({ path: resolve(opts.cwd, path) }),
    readBytes: async (target: { path: string }) => new Uint8Array(await readFile(target.path)),
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(plugin)
  const run = async (args: Record<string, unknown>) => await executeToolFixture(ctx, {
    callId: ToolCallId('c1'), name: 'generate_image', arguments: args,
    agent: { id: 'a1' } as unknown as Agent, signal: new AbortController().signal,
  })
  const setCandidates = (value: boolean): void => {
    candidates = value
    ctx.emit('suanli-model-catalog/roles-updated')
  }
  return { ctx, cwd, ask, submit, run, fiber, setCandidates }
}

/** Text of one result. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(block => block.text ?? '').join('')
}

describe('generate_image', () => {
  it('submits without a card when every parameter is supported, and saves into generated/', async () => {
    const { ask, submit, run, cwd } = await boot()
    const result = await run({ prompt: '小猫玩耍', aspect_ratio: '竖屏', resolution: '2k' })
    expect(result.isError).toBe(false)
    expect(ask).not.toHaveBeenCalled()
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'generate_image', model: 'minimax-h3-image', prompt: '小猫玩耍', params: { aspect_ratio: '9:16', resolution: '2K' },
      size: '1536x2720',
    }))
    const files = await readdir(join(cwd, 'generated'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.png$/u)
    expect(JSON.parse(textOf(result))).toMatchObject({ status: 'generated', parameters: { aspect_ratio: '9:16', resolution: '2K' } })
  })

  it('refuses before submitting when generated/ points outside the workspace', async () => {
    const { submit, run, cwd } = await boot()
    const outside = await mkdtemp(join(tmpdir(), 'suanli-media-outside-'))
    dirs.push(outside)
    await symlink(outside, join(cwd, 'generated'))
    const result = await run({ prompt: '小猫玩耍', aspect_ratio: '竖屏', resolution: '2k' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('outside the workspace')
    expect(submit).not.toHaveBeenCalled()
    expect(await readdir(outside)).toEqual([])
  })

  it('asks for both missing parameters on one card, catalog default first', async () => {
    const { ask, submit, run } = await boot({
      answer: () => ({ answers: [{ id: 'aspect_ratio', selected: ['16:9'] }, { id: 'resolution', selected: ['1K'] }] }),
    })
    await run({ prompt: '小猫玩耍' })
    expect(ask).toHaveBeenCalledTimes(1)
    const questions = ask.mock.calls[0]?.[0].questions ?? []
    expect(questions.map(question => question.id)).toEqual(['aspect_ratio', 'resolution'])
    expect(questions[1]?.options?.[0]).toEqual({ label: '2K', description: '默认' })
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ params: { aspect_ratio: '16:9', resolution: '1K' } }))
  })

  it('asks only for the aspect ratio when the resolution is supported', async () => {
    const { ask, run } = await boot({ answer: () => ({ answers: [{ id: 'aspect_ratio', selected: ['自适应'] }] }) })
    await run({ prompt: '小猫玩耍', resolution: '2K' })
    expect(ask.mock.calls[0]?.[0].questions.map(question => question.id)).toEqual(['aspect_ratio'])
  })

  it('puts an unsupported value before missing parameters on the question card', async () => {
    const { ask, run } = await boot()
    await run({ prompt: '小猫玩耍', resolution: '4K' })
    const questions = ask.mock.calls[0]?.[0].questions ?? []
    expect(questions[0]?.id).toBe('resolution')
    expect(questions[0]?.question).toContain('当前不支持「4K」')
  })

  it('names an unsupported value and lists what is supported', async () => {
    const { ask, submit, run } = await boot({
      answer: () => ({ answers: [{ id: 'aspect_ratio', selected: ['1:1'] }, { id: 'resolution', selected: ['2K'] }] }),
    })
    await run({ prompt: '小猫玩耍', resolution: '4K高清' })
    const resolution = ask.mock.calls[0]?.[0].questions.find(question => question.id === 'resolution')
    expect(resolution?.question).toBe('当前不支持「4K高清」，请选择分辨率')
    expect(resolution?.detail).toBe('支持：1K、2K')
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ params: { aspect_ratio: '1:1', resolution: '2K' } }))
  })

  it('submits nothing when the user skips the card', async () => {
    const { submit, run } = await boot({ answer: () => ({ answers: [{ id: 'aspect_ratio', selected: [] }, { id: 'resolution', selected: [] }] }) })
    const result = await run({ prompt: '小猫玩耍' })
    expect(submit).not.toHaveBeenCalled()
    expect(textOf(result)).toContain('cancelled')
  })

  it('asks again once for an unsupported custom answer, then fails', async () => {
    const { ask, submit, run } = await boot({ answer: () => ({ answers: [{ id: 'aspect_ratio', selected: [], custom: '3:7' }] }) })
    const result = await run({ prompt: '小猫玩耍', resolution: '2K' })
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls[1]?.[0].questions[0]?.question).toBe('当前不支持「3:7」，请选择宽高比')
    expect(result.isError).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it('exists only while the catalog offers an image model, and leaves with its plugin', async () => {
    const { ctx, setCandidates, fiber } = await boot()
    expect(ctx.tools.get('generate_image')).toBeDefined()
    setCandidates(false)
    expect(ctx.tools.get('generate_image')).toBeUndefined()
    setCandidates(true)
    expect(ctx.tools.get('generate_image')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('generate_image')).toBeUndefined()
  })
})
