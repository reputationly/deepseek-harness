import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CanvasService from '@deepseek-ai/dsh-canvas'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
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

class MediaTestCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly value?: string) {
    super(ctx)
  }

  override resolve(): ReturnType<CredentialProvider['resolve']> {
    return Promise.resolve(this.value === undefined ? undefined : { value: this.value, source: 'memory' })
  }

  override describe(): ReturnType<CredentialProvider['describe']> {
    return Promise.resolve({ configured: true, source: 'memory', writable: true })
  }

  override set(): Promise<void> { return Promise.resolve() }
  override unset(): Promise<void> { return Promise.resolve() }
  override readRecord(): ReturnType<CredentialProvider['readRecord']> { return Promise.resolve(undefined) }
  override describeRecord(): ReturnType<CredentialProvider['describeRecord']> { return Promise.resolve({ configured: false, writable: true }) }
  override listRecords(): ReturnType<CredentialProvider['listRecords']> { return Promise.resolve([]) }
  override modifyRecord(): ReturnType<CredentialProvider['modifyRecord']> { return Promise.resolve(undefined) }
  override deleteRecord(): Promise<void> { return Promise.resolve() }
}

function response(body: unknown, headers?: HeadersInit): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    headers: headers ?? { 'content-type': 'application/json' },
  })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a string request body')
  return init.body
}

function requestJson(init: RequestInit | undefined): Record<string, unknown> {
  const body: unknown = JSON.parse(requestBody(init))
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Expected a JSON object request body')
  return body as Record<string, unknown>
}

function toolText(result: Awaited<ReturnType<typeof call>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function artifactPath(result: Awaited<ReturnType<typeof call>>): string {
  const text = toolText(result)
  const path = /^Wrote (.+?)(?: with |\. It is canvas node )/u.exec(text)?.[1]
  if (path === undefined) throw new Error(`No artifact path in tool output: ${text}`)
  return path
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
      const url = requestUrl(input)
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
    const music = await call('generate_music', { prompt: 'Gentle piano and strings', lyrics: 'A quiet morning' })

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
    const musicRequest = fetchSpy.mock.calls.find(([input, init]) =>
      requestUrl(input).endsWith('/videos') && init?.method === 'POST')
    expect(requestJson(musicRequest?.[1])).toMatchObject({
      metadata: { instructions: 'Gentle piano and strings', lyrics: 'A quiet morning' },
    })
  })

  it('uses stored credentials before the ambient reference', async () => {
    new MediaTestCredentials(ctx, 'sk-from-credentials')
    fetchSpy.mockResolvedValueOnce(response('audio', { 'content-type': 'audio/mpeg' }))
    await ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      apiKeyEnv: 'DSH_MAAS_API_KEY',
      catalog: false,
      outputDir: directory,
    })
    await call('generate_speech', { text: 'Hello', voice: 'https://voice.example/sample.wav' })
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer sk-from-credentials' })
  })

  it('falls back to the ambient reference when the credentials service has no stored value', async () => {
    new MediaTestCredentials(ctx)
    fetchSpy.mockResolvedValueOnce(response('audio', { 'content-type': 'audio/mpeg' }))
    await ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      catalog: false,
      outputDir: directory,
    })
    await call('generate_speech', { text: 'Hello', voice: 'https://voice.example/sample.wav' })
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer sk-test-media' })
  })

  it.each([undefined, ''])('reports a missing API key for an unset reference (%s)', async (value) => {
    if (value === undefined) delete process.env.DSH_MAAS_API_KEY
    else process.env.DSH_MAAS_API_KEY = value
    await ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      catalog: false,
      outputDir: directory,
    })
    const result = await call('generate_speech', { text: 'Hello', voice: 'https://voice.example/sample.wav' })
    expect(result.isError).toBe(true)
    expect(toolText(result)).toContain('no API key for DSH_MAAS_API_KEY')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('encodes local voice files and maps response MIME types to artifact extensions', async () => {
    const extensions = ['.mp3', '.m4a', '.flac', '.wav']
    for (const extension of extensions) await writeFile(join(directory, `voice${extension}`), 'voice sample')
    const responseTypes = ['image/png', 'image/jpeg', 'image/webp', 'audio/wav', 'audio/mp3', 'audio/mpeg', 'video/mp4', 'application/octet-stream']
    let responseIndex = 0
    fetchSpy.mockImplementation(async () => response('generated audio', {
      'content-type': responseTypes[responseIndex++] ?? 'audio/mpeg',
    }))
    await ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      catalog: false,
      outputDir: directory,
    })
    const resultPaths: string[] = []
    for (let index = 0; index < responseTypes.length; index++) {
      const result = await call('generate_speech', {
        text: `line ${String(index)}`,
        voice: join(directory, `voice${extensions[index % extensions.length]}`),
      })
      resultPaths.push(artifactPath(result))
    }
    expect(fetchSpy.mock.calls.slice(0, 4).map(([, init]) => {
      const body = requestJson(init)
      const voice = body.voice
      if (typeof voice !== 'string') throw new Error('Expected encoded reference voice')
      return voice.slice(0, voice.indexOf(';'))
    })).toEqual(['data:audio/mpeg', 'data:audio/mp4', 'data:audio/flac', 'data:audio/wav'])
    expect(resultPaths.map(path => path.slice(path.lastIndexOf('.')))).toEqual([
      '.png', '.jpg', '.webp', '.wav', '.mp3', '.mp3', '.mp4', '.bin',
    ])
  })

  it('resolves relative output directories for generated and edited media', async () => {
    const previousDirectory = process.cwd()
    process.chdir(directory)
    try {
      await writeFile(join(directory, 'input.mp4'), 'input')
      fetchSpy.mockResolvedValueOnce(response('audio', { 'content-type': 'audio/mpeg' }))
      await ctx.plugin(ToolMedia, {
        baseURL: 'https://gateway.example/v1',
        catalog: false,
        outputDir: 'relative-artifacts',
        ffmpegPath: '/no/such/ffmpeg',
      })
      const speech = await call('generate_speech', { text: 'Hello', voice: 'https://voice.example/sample.wav' })
      expect(artifactPath(speech)).toContain(join(directory, 'relative-artifacts', 'speech-'))
      const edit = await call('ffmpeg', { args: ['-i', 'input.mp4'] })
      expect(edit.isError).toBe(true)
      expect(toolText(edit)).toContain('未找到 ffmpeg')
    } finally {
      process.chdir(previousDirectory)
    }
  })

  it('uses a configured catalog cache and returns an explicit choice before generating', async () => {
    fetchSpy.mockResolvedValueOnce(response({
      version: 'v1',
      capabilities: [{
        id: 'image', operation: 'generate_image', model: 'qwen-image-pro', taskTypes: ['t2i'], default: true,
        paramSchema: { properties: {
          aspect_ratio: { enum: ['1:1', '16:9'], default: '1:1', title: 'Ratio' },
          resolution: { enum: ['1K', '2K'], default: '2K', title: 'Resolution' },
        } },
      }],
    }))
    await ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      catalog: true,
      catalogCacheFile: join(directory, 'catalog-cache.json'),
      outputDir: directory,
    })
    const result = await call('generate_image', { prompt: 'A cat' })
    expect(result.meta).toMatchObject({ status: 'needs_choice' })
    expect(toolText(result)).toContain('Nothing was generated yet')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('writes generated images to the configured output directory and canvas', async () => {
    fetchSpy.mockImplementation(async (input) => {
      const url = requestUrl(input)
      if (url.endsWith('/images/generations')) return response({ data: [{ url: 'https://media.example/image.png' }] })
      if (url === 'https://media.example/image.png') return response('image', { 'content-type': 'image/png' })
      throw new Error(`Unexpected media request: ${url}`)
    })
    await ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      catalog: false,
      outputDir: directory,
      ffmpegPath: '/no/such/ffmpeg',
    })
    const image = await call('generate_image', { prompt: 'A still life' })
    expect(image.isError).toBe(false)
    expect(artifactPath(image)).toMatch(/image-.*\.png$/u)
    const imageNode = (await ctx.canvas.read(session)).nodes.find(node => node.type === 'image')
    if (imageNode?.type !== 'image') throw new Error('Expected an image canvas node')
    expect(imageNode.path).toMatch(/\.png$/u)
    const edit = await call('ffmpeg', { args: ['-i', 'input.mp4'] })
    expect(edit.isError).toBe(true)
    expect(toolText(edit)).toContain('未找到 ffmpeg')
  })

  it('resolves relative output directories for speech and ffmpeg edits', async () => {
    const previousDirectory = process.cwd()
    process.chdir(directory)
    try {
      await writeFile(join(directory, 'input.mp4'), 'input')
      const fontFile = join(directory, 'cjk.ttf')
      await writeFile(fontFile, 'font')
      fetchSpy.mockResolvedValueOnce(response('audio', { 'content-type': 'audio/mpeg' }))
      await ctx.plugin(ToolMedia, {
        baseURL: 'https://gateway.example/v1',
        catalog: false,
        outputDir: 'relative-media',
        ffmpegPath: '/no/such/ffmpeg',
        fontFile,
      })
      const speech = await call('generate_speech', { text: 'Hello', voice: 'https://voice.example/sample.wav' })
      expect(artifactPath(speech)).toContain(join(directory, 'relative-media', 'speech-'))
      const edit = await call('ffmpeg', { args: ['-i', 'input.mp4', '-vf', "drawtext=text='你好'"] })
      expect(edit.isError).toBe(true)
      expect(toolText(edit)).toContain('未找到 ffmpeg')
    } finally {
      process.chdir(previousDirectory)
    }
  })

  it('keeps generated audio available when canvas placement fails', async () => {
    await writeFile(join(directory, '.canvas'), 'not a directory')
    fetchSpy.mockImplementation(async (input, init) => {
      const url = requestUrl(input)
      if (url.endsWith('/audio/speech')) return response('speech', { 'content-type': 'audio/mpeg' })
      if (url.endsWith('/videos') && init?.method === 'POST') return response({ id: 'music-error-task' })
      if (url.endsWith('/videos/music-error-task')) return response({ status: 'completed', url: 'https://media.example/music.mp3' })
      if (url === 'https://media.example/music.mp3') return response('music', { 'content-type': 'audio/mpeg' })
      throw new Error(`Unexpected media request: ${url}`)
    })
    await ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      catalog: false,
      outputDir: directory,
      pollIntervalMs: 1,
      taskTimeoutMs: 2_000,
    })
    const speech = await call('generate_speech', { text: 'Hello', voice: 'https://voice.example/sample.wav' })
    const music = await call('generate_music', { prompt: 'Quiet guitar' })
    expect(toolText(speech)).toContain('Canvas placement failed:')
    expect(toolText(music)).toContain('Canvas placement failed:')
  })

  it('omits absent lyrics from music task metadata', async () => {
    fetchSpy.mockImplementation(async (input, init) => {
      const url = requestUrl(input)
      if (url.endsWith('/videos') && init?.method === 'POST') return response({ id: 'music-no-lyrics' })
      if (url.endsWith('/videos/music-no-lyrics')) return response({ status: 'completed', url: 'https://media.example/no-lyrics.mp3' })
      if (url === 'https://media.example/no-lyrics.mp3') return response('music', { 'content-type': 'audio/mpeg' })
      throw new Error(`Unexpected media request: ${url}`)
    })
    await ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      catalog: false,
      outputDir: directory,
      pollIntervalMs: 1,
      taskTimeoutMs: 2_000,
    })
    await call('generate_music', { prompt: 'Quiet guitar' })
    const request = fetchSpy.mock.calls.find(([input, init]) =>
      requestUrl(input).endsWith('/videos') && init?.method === 'POST')
    expect(requestJson(request?.[1])).toMatchObject({
      metadata: { instructions: 'Quiet guitar' },
    })
    expect(requestJson(request?.[1]).metadata).not.toHaveProperty('lyrics')
  })
})
