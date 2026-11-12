import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CanvasService from '@deepseek-ai/dsh-canvas'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolMedia from '../src/index.ts'

let ctx: Context
let session: Session
let directory: string
let fetchSpy: MockInstance<typeof globalThis.fetch>
let previousKey: string | undefined
let calls = 0

function response(body: unknown, headers?: HeadersInit): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: headers ?? { 'content-type': 'application/json' },
  })
}

async function call(name: string, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`audio-${String(++calls)}`),
    name,
    arguments: args,
    agent: { id: session.id, session } as never,
  })
}

beforeEach(async () => {
  calls = 0
  directory = await mkdtemp(join(tmpdir(), 'dsh-audio-canvas-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService)
  session = Session.create(SessionId('audio-canvas-session'))
  previousKey = process.env.DSH_MAAS_API_KEY
  process.env.DSH_MAAS_API_KEY = 'sk-test-media'
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(async () => {
  fetchSpy.mockRestore()
  if (previousKey === undefined) delete process.env.DSH_MAAS_API_KEY
  else process.env.DSH_MAAS_API_KEY = previousKey
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
})

describe('generated audio canvas placement', () => {
  it('places speech and music files as audio nodes with their derivation metadata', async () => {
    fetchSpy.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/audio/speech')) return response('speech-bytes', { 'content-type': 'audio/mpeg' })
      if (url.endsWith('/videos') && init?.method === 'POST') return response({ id: 'music-task' })
      if (url.endsWith('/videos/music-task')) return response({ status: 'completed', url: 'https://media.example/music.mp3' })
      if (url === 'https://media.example/music.mp3') return response('music-bytes', { 'content-type': 'audio/mpeg' })
      throw new Error(`Unexpected media request: ${url}`)
    })
    await ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      catalog: false,
      outputDir: directory,
      pollIntervalMs: 1,
      taskTimeoutMs: 2_000,
    })

    const speech = await call('generate_speech', { text: 'Hello there', voice: 'https://voice.example/reference.wav' })
    const music = await call('generate_music', { prompt: 'Gentle piano and strings' })

    expect(speech.meta).toMatchObject({ model: 'indextts-2.5', nodeId: 'n1' })
    expect(music.meta).toMatchObject({ model: 'minimax-music3', nodeId: 'n2' })
    const document = await ctx.canvas.read(session)
    expect(document.nodes).toMatchObject([
      { id: 'n1', type: 'audio', title: 'Speech', prompt: 'Hello there', model: 'indextts-2.5' },
      { id: 'n2', type: 'audio', title: 'Music', prompt: 'Gentle piano and strings', model: 'minimax-music3' },
    ])
    expect(await readFile(document.nodes[0]!.path!, 'utf8')).toBe('speech-bytes')
    expect(await readFile(document.nodes[1]!.path!, 'utf8')).toBe('music-bytes')
    expect(document.edges).toEqual([])
  })
})
