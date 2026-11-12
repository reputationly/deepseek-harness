import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createGenerator } from '../src/generators.ts'
import type { MediaCall } from '../src/runner.ts'
import type { CanvasNode } from '@deepseek-ai/dsh-canvas'

const PNG = Buffer.from('iVBORw0KGgo=', 'base64')
const MP4 = Buffer.from('AAAA', 'base64')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const binary = (bytes: Buffer, type: string) => new Response(new Uint8Array(bytes), { headers: { 'content-type': type } })

let directory: string
let fetchSpy: MockInstance<typeof fetch>
let written: string[]

const node = (type: CanvasNode['type'], prompt = '', params: Record<string, string> = {}): CanvasNode => ({
  id: 'n1' as never, type, title: 'node', x: 0, y: 0, width: 1, height: 1,
  gen: { kind: type === 'audio' ? 'speech' : 'image', prompt, params },
})

const call = (overrides: Partial<MediaCall> = {}): MediaCall => ({
  node: node('image'),
  entry: { node: 'n1' as never, kind: 'image', model: 'model', calls: 1 },
  prompt: 'draw it',
  refs: [],
  signal: new AbortController().signal,
  ...overrides,
})

function generator(): ReturnType<typeof createGenerator> {
  return createGenerator({
    request: signal => Promise.resolve({ baseURL: 'https://gateway.example/v1', apiKey: 'sk-test', signal }),
    write: async (prefix, contentType, bytes) => {
      const path = join(directory, `${prefix}-${String(written.length)}.out`)
      await writeFile(path, bytes)
      written.push(`${path}:${contentType}`)
      return path
    },
    taskTimeoutMs: 5_000,
    pollIntervalMs: 1,
    videoDefaultDuration: 5,
  })
}

describe('generators', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-media-generators-'))
    written = []
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(async () => {
    fetchSpy.mockRestore()
    await rm(directory, { recursive: true, force: true })
  })

  it('generates an image from the prompt and writes its bytes', async () => {
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    const media = await generator().image(call())
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/images/generations')
    expect(media.model).toBe('model')
    expect(await readFile(media.path)).toEqual(PNG)
    expect(written[0]).toContain('image/png')
  })

  it('edits reference images instead of generating from text alone', async () => {
    const ref = join(directory, 'ref.png')
    await writeFile(ref, PNG)
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    await generator().image(call({ refs: [ref] }))
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/images/edits')
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as { images: string[] }
    expect(body.images[0]).toContain('base64,')
  })

  it('submits a video task, waits for it, and records nothing itself', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ id: 't1' }))
      .mockResolvedValueOnce(json({ status: 'succeeded', url: `data:video/mp4;base64,${MP4.toString('base64')}` }))
    const media = await generator().video(call({
      node: node('video'), entry: { node: 'n1' as never, kind: 'video', model: 'video-model', calls: 1, seconds: 6 },
    }))
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/videos')
    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as { duration: number; metadata: { task_type: string } }
    expect(body.metadata.task_type).toBe('t2v')
    expect(body.duration).toBe(6)
    expect(media.model).toBe('video-model')
    expect(await readFile(media.path)).toEqual(MP4)
  })

  it('synthesizes speech with the voice the node carries', async () => {
    fetchSpy.mockResolvedValueOnce(binary(Buffer.from('mp3'), 'audio/mpeg'))
    const media = await generator().speech(call({
      node: node('audio', '你好', { voice: 'voice-lin' }),
      entry: { node: 'n1' as never, kind: 'speech', model: 'speech-model', calls: 1, lines: 1 },
    }))
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/audio/speech')
    expect(await readFile(media.path)).toEqual(Buffer.from('mp3'))
  })

  it('refuses to speak without a voice', async () => {
    await expect(generator().speech(call({
      node: node('audio', '你好'),
      entry: { node: 'n1' as never, kind: 'speech', model: 'speech-model', calls: 1 },
    }))).rejects.toThrow('needs a voice')
  })

  it('generates music through the task endpoints', async () => {
    fetchSpy
      .mockResolvedValueOnce(json({ id: 'm1' }))
      .mockResolvedValueOnce(json({ status: 'succeeded', url: `data:audio/mpeg;base64,${Buffer.from('x').toString('base64')}` }))
    const media = await generator().music(call({
      node: node('audio'), prompt: '', entry: { node: 'n1' as never, kind: 'music', model: 'music-model', calls: 1 },
    }))
    expect(media.model).toBe('music-model')
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/videos')
  })

  it('reports a gateway failure', async () => {
    fetchSpy.mockResolvedValueOnce(json({ error: { message: 'no credit' } }, 402))
    await expect(generator().image(call())).rejects.toThrow('no credit')
  })
})
