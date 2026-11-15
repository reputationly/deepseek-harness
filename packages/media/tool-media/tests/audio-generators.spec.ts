/** Audio gateway requests retain composition data across the durable task boundary. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasNodeId } from '@deepseek-ai/dsh-canvas'
import type { MediaCatalog } from '../src/catalog.ts'
import { AudioPlanError } from '../src/audio-plan.ts'
import { createGenerator } from '../src/generators.ts'
import type { MediaCall } from '../src/runner.ts'

let directory: string
const fetchMock = vi.fn<typeof fetch>()
const json = (body: object) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const score = 'X:1\nT:测试曲\nM:4/4\nK:C\nC D E F | G4 |\n'
const mediaURL = 'data:audio/wav;base64,YXVkaW8='
const endpoint = createHash('sha256').update('https://gateway.example/v1').digest('hex')
const catalog: MediaCatalog = { version: 'audio', source: 'live', capabilities: [
  ...['minimax-music3', 'yue2', 'ace-step'].map(model => ({ id: model, operation: 'generate_music', model,
    taskTypes: model === 'ace-step' ? ['t2m', 'cover', 'repaint'] : ['t2m'], transport: { kind: 'videos_task' } })),
  { id: 'breeze', operation: 'generate_speech', model: 'breeze-tts-2', transport: { kind: 'videos_task' } },
  { id: 'index', operation: 'generate_speech', model: 'indextts-2.5', transport: { kind: 'videos_task' } },
  { id: 'tts2', operation: 'generate_speech', model: 'tts2', transport: { kind: 'audio_speech' } },
] }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-audio-'))
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

function generator(load = async () => catalog) {
  return createGenerator({
    catalog: load,
    request: signal => Promise.resolve({ baseURL: 'https://gateway.example/v1', apiKey: 'test', signal }),
    write: async (prefix, _type, bytes, onPath) => {
      const path = join(directory, `${prefix}.wav`)
      await onPath?.(path)
      await writeFile(path, bytes)
      return path
    },
    taskTimeoutMs: 1000, pollIntervalMs: 1, videoDefaultDuration: 5,
  })
}

function call(model: string, params: Record<string, string | number | boolean> = {}, kind: 'music' | 'speech' = 'music'): MediaCall {
  const node = brandString<CanvasNodeId>('n1')
  return { node: { id: node, type: 'audio', title: 'song', x: 0, y: 0, width: 1, height: 1, gen: { kind, prompt: '温暖的民谣', params } },
    entry: { node, model, kind, calls: 1, lines: 1 }, prompt: '温暖的民谣', refs: [], signal: new AbortController().signal }
}

function completed(metadata?: object) {
  fetchMock.mockResolvedValueOnce(json({ id: 'audio-task' }))
    .mockResolvedValueOnce(json({ status: 'succeeded', url: mediaURL, ...metadata === undefined ? {} : { metadata } }))
}

function requestText(): string {
  const value = fetchMock.mock.calls[0]?.[1]?.body
  if (typeof value !== 'string') throw new Error('Expected a JSON request body')
  return value
}

function body() {
  return JSON.parse(requestText()) as { prompt: string; metadata: Record<string, string | number | boolean> }
}

it('sends Music3 lyrics as prompt and the arrangement as instructions, preserving seed zero', async () => {
  completed()
  const submitting = vi.fn<NonNullable<MediaCall['onSubmitting']>>().mockResolvedValue(undefined)
  const result = await generator().music({ ...call('minimax-music3', { lyrics: '风吹过长街\n我们一起向前', seed: 0, max_new_tokens: 750 }), onSubmitting: submitting })
  expect(body()).toEqual({ model: 'minimax-music3', prompt: '风吹过长街\n我们一起向前', metadata: {
    task_type: 't2m', instructions: '温暖的民谣', seed: 0, max_new_tokens: 750,
  } })
  const expectedParams1: unknown = expect.objectContaining({ seed: 0, instructions: '温暖的民谣' })
  expect(submitting).toHaveBeenCalledWith({ prompt: '风吹过长街\n我们一起向前', params: expectedParams1 })
  expect(result.params?.instructions).toBe('温暖的民谣')
})

it('checkpoints YuE2 planning settings before submission and the rendered ABC before writing audio', async () => {
  let prepared = false
  const artifact = vi.fn<NonNullable<MediaCall['onArtifact']>>().mockResolvedValue(undefined)
  fetchMock.mockImplementationOnce(async () => {
    expect(prepared).toBe(true)
    return json({ id: 'audio-task' })
  }).mockResolvedValueOnce(json({ status: 'succeeded', url: mediaURL, metadata: { score_abc: score } }))
  const result = await generator().music({ ...call('yue2', { lyrics: '让风带我远行' }),
    onSubmitting: async (input) => { expect(input?.params?.cot).toBe('full'); prepared = true }, onArtifact: artifact })
  expect(result.params?.abc).toBe(score)
  expect(body().metadata).toMatchObject({ cot: 'full', lyrics: '让风带我远行' })
  const expectedParams2: unknown = expect.objectContaining({ abc: score, cot: 'full' })
  expect(artifact).toHaveBeenCalledWith(expect.objectContaining({ params: expectedParams2 }))
})

it('passes edited ABC and melody planning into a new YuE2 task', async () => {
  completed({ score_abc: `${score}% rendered\n` })
  const result = await generator().music(call('yue2', { abc: score, cot: 'melody', lyrics: '新的歌词' }))
  expect(body().metadata).toMatchObject({ abc: score, cot: 'melody' })
  expect(result.params?.abc).toBe(`${score}% rendered\n`)
})

it('omits cleared optional controls while preserving explicit zero and false', async () => {
  completed()
  const result = await generator().music(call('ace-step', { lyrics: '', bpm: '', key_scale: '', seed: 0, thinking: false }))
  expect(body().metadata).toMatchObject({ seed: 0, use_random_seed: false, thinking: false })
  expect(body().metadata).not.toHaveProperty('bpm')
  expect(body().metadata).not.toHaveProperty('key_scale')
  expect(result.params).toMatchObject({ seed: 0, use_random_seed: false, thinking: false })
})

it('submits Breeze voice design without a reference and preserves expressive text', async () => {
  completed()
  const submitted = vi.fn<NonNullable<MediaCall['onSubmitted']>>().mockResolvedValue(undefined)
  await generator().speech({ ...call('breeze-tts-2', { instructions: '沉稳的女声，语气轻柔', seed: 0 }, 'speech'),
    prompt: '[叹气] 终于等到你了。', onSubmitted: submitted })
  expect(body()).toEqual({ model: 'breeze-tts-2', prompt: '[叹气] 终于等到你了。', metadata: {
    task_type: 'tts', instructions: '沉稳的女声，语气轻柔', seed: 0,
  } })
  expect(submitted).toHaveBeenCalledWith({ id: 'audio-task', model: 'breeze-tts-2', kind: 'speech', endpoint })
})

it('uses the declared task transport for IndexTTS and materializes its canvas audio reference', async () => {
  completed()
  const source = join(directory, '角色参考.wav')
  await writeFile(source, 'voice')
  await generator().speech({ ...call('indextts-2.5', {}, 'speech'), audioReferences: [source] })
  expect(body().metadata).toMatchObject({ task_type: 'tts', voice: 'data:audio/wav;base64,dm9pY2U=' })
})

it('preserves the requested speech format through native transport and the saved recipe', async () => {
  fetchMock.mockResolvedValueOnce(new Response('audio', { headers: { 'content-type': 'audio/wav' } }))
  const native: MediaCatalog = { ...catalog, capabilities: [{ id: 'index-native', operation: 'generate_speech', model: 'indextts-2.5', transport: { kind: 'audio_speech' } }] }
  const result = await generator(async () => native).speech(call('indextts-2.5', { voice: 'data:audio/wav;base64,dm9pY2U=', format: 'wav' }, 'speech'))
  expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/audio/speech')
  const request = JSON.parse(requestText()) as Record<string, unknown>
  expect(request).toMatchObject({ response_format: 'wav', voice: 'data:audio/wav;base64,dm9pY2U=' })
  expect(request).not.toHaveProperty('format')
  expect(result.params?.format).toBe('wav')
})

it('sends tts2 speech without a voice or instructions and lets the gateway pick the default voice', async () => {
  fetchMock.mockResolvedValueOnce(new Response('audio', { headers: { 'content-type': 'audio/wav' } }))
  const result = await generator().speech(call('tts2', {}, 'speech'))
  expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/audio/speech')
  const request = JSON.parse(requestText()) as Record<string, unknown>
  expect(request).toMatchObject({ model: 'tts2', input: '温暖的民谣' })
  expect(request).not.toHaveProperty('voice')
  expect(request).not.toHaveProperty('instructions')
  expect(result.params).toEqual({})
})

it('forwards tts2 voice-design instructions while keeping the reference optional', async () => {
  fetchMock.mockResolvedValueOnce(new Response('audio', { headers: { 'content-type': 'audio/wav' } }))
  await generator().speech(call('tts2', { instructions: '年轻女性，语速稍慢' }, 'speech'))
  const request = JSON.parse(requestText()) as Record<string, unknown>
  expect(request).toMatchObject({ model: 'tts2', instructions: '年轻女性，语速稍慢' })
  expect(request).not.toHaveProperty('voice')
})

it('clones a tts2 reference voice only with its transcript and records ref_text in the version params', async () => {
  fetchMock.mockResolvedValueOnce(new Response('audio', { headers: { 'content-type': 'audio/wav' } }))
  const source = join(directory, '参考音.wav')
  await writeFile(source, 'voice')
  const result = await generator().speech({ ...call('tts2', { ref_text: '你好，这里是参考音频的逐字稿。' }, 'speech'), audioReferences: [source] })
  const request = JSON.parse(requestText()) as Record<string, unknown>
  expect(request).toMatchObject({ model: 'tts2', ref_text: '你好，这里是参考音频的逐字稿。', voice: 'data:audio/wav;base64,dm9pY2U=' })
  expect(result.params?.ref_text).toBe('你好，这里是参考音频的逐字稿。')
})

it.each([{}, { ref_text: '' }, { ref_text: '   ' }])('rejects a tts2 reference voice without its transcript before any request', async (params) => {
  const source = join(directory, '参考音.wav')
  await writeFile(source, 'voice')
  await expect(generator().speech({ ...call('tts2', params, 'speech'), audioReferences: [source] }))
    .rejects.toMatchObject({ code: 'missing_input', status: 400 })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('rejects a tts2 voice path in params without ref_text before any request', async () => {
  const source = join(directory, '参考音.wav')
  await writeFile(source, 'voice')
  await expect(generator().speech(call('tts2', { voice: source }, 'speech')))
    .rejects.toMatchObject({ code: 'missing_input', status: 400 })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('rejects tts2 language because the gateway detects it from the text', async () => {
  await expect(generator().speech(call('tts2', { language: 'zh' }, 'speech')))
    .rejects.toMatchObject({ code: 'unsupported_mode', status: 400 })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('does not infer paid audio editing modes from a model name when the catalog omits task modes', async () => {
  const basic: MediaCatalog = { ...catalog, capabilities: [{ id: 'ace-basic', operation: 'generate_music', model: 'ace-step', transport: { kind: 'videos_task' } }] }
  const source = join(directory, 'original.wav')
  await writeFile(source, 'original')
  await expect(generator(async () => basic).music({ ...call('ace-step', { task_type: 'cover' }), audioReferences: [source] })).rejects.toMatchObject({ code: 'unsupported_mode' })
  expect(fetchMock).not.toHaveBeenCalled()
  completed()
  await generator(async () => basic).music(call('ace-step', { is_instrumental: true }))
  expect(body().metadata).toMatchObject({ task_type: 't2m', instrumental: true })
})

it('sends ACE-Step repaint bounds and the source bytes, keeping encoded audio out of version settings', async () => {
  completed()
  const source = join(directory, 'original.wav')
  await writeFile(source, 'original')
  const result = await generator().music({ ...call('ace-step', { task_type: 'repaint', repainting_start: 0, repainting_end: 8,
    repaint_mode: 'balanced', repaint_strength: 0.5, audio_duration: 30, bpm: 96, seed: 0, thinking: false }), audioReferences: [source] })
  expect(body().metadata).toEqual({ task_type: 'repaint', repainting_start: 0, repainting_end: 8, repaint_mode: 'balanced',
    repaint_strength: 0.5, audio_duration: 30, bpm: 96, seed: 0, use_random_seed: false, thinking: false, batch_size: 1,
    src_audio: 'data:audio/wav;base64,b3JpZ2luYWw=' })
  expect(result.params?.src_audio).toBeUndefined()
})

it('uses reference_audio for ACE-Step covers and retains influence zero', async () => {
  completed()
  await generator().music(call('ace-step', { task_type: 'cover', reference_audio: mediaURL, audio_cover_strength: 0 }))
  expect(body().metadata).toMatchObject({ task_type: 'cover', reference_audio: mediaURL, audio_cover_strength: 0, batch_size: 1 })
})

it('keeps instrumental ACE-Step requests separate from automatic lyric writing', async () => {
  completed()
  await generator().music(call('ace-step', { is_instrumental: true }))
  expect(body().metadata).toMatchObject({ instrumental: true, lyrics: '[Instrumental]' })
  expect(body().metadata.sample_mode).toBeUndefined()
})

it.each([
  ['ace-step', { task_type: 'repaint', src_audio: mediaURL, repainting_start: 8, repainting_end: 2 }, 'invalid_range'],
  ['ace-step', { task_type: 'cover' }, 'missing_input'],
  ['minimax-music3', {}, 'missing_input'],
  ['yue2', { task_type: 'cover' }, 'unsupported_mode'],
] as const)('rejects an incomplete %s request before submission intent', async (model, params, code) => {
  const submitting = vi.fn()
  await expect(generator().music({ ...call(model, params), onSubmitting: submitting })).rejects.toMatchObject({ code, status: 400 })
  expect(submitting).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('rejects a model absent from this key catalog before any paid request', async () => {
  await expect(generator(async () => ({ version: 'empty', source: 'live', capabilities: [] })).music(call('yue2')))
    .rejects.toMatchObject({ code: 'model_unavailable' })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('does not fall back to an unlisted audio model when refreshing the catalog fails', async () => {
  await expect(generator(() => Promise.reject(new Error('catalog unavailable'))).music(call('yue2'))).rejects.toThrow('catalog unavailable')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('rejects unsupported Breeze cloning rather than submitting a design with the reference discarded', async () => {
  await expect(generator().speech(call('breeze-tts-2', { voice: mediaURL, instructions: '女声' }, 'speech')))
    .rejects.toBeInstanceOf(AudioPlanError)
  expect(fetchMock).not.toHaveBeenCalled()
})

it('resumes a completed YuE2 task with its rendered score, without a second submission', async () => {
  fetchMock.mockResolvedValueOnce(json({ status: 'succeeded', url: mediaURL, metadata: { score_abc: score } }))
  const result = await generator().resume?.({ id: 'existing', model: 'yue2', kind: 'music', endpoint }, new AbortController().signal)
  expect(result?.params?.abc).toBe(score)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gateway.example/v1/videos/existing')
})

it('resumes an existing speech task without starting synthesis again', async () => {
  fetchMock.mockResolvedValueOnce(json({ status: 'succeeded', url: mediaURL }))
  const result = await generator().resume?.({ id: 'existing', model: 'breeze-tts-2', kind: 'speech', endpoint }, new AbortController().signal)
  expect(result?.model).toBe('breeze-tts-2')
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined()
})

it('refuses a malformed score response without presenting an audio artifact as complete', async () => {
  completed({ score_abc: { abc: score } })
  const artifact = vi.fn()
  await expect(generator().music({ ...call('yue2'), onArtifact: artifact })).rejects.toThrow('invalid ABC score')
  expect(artifact).not.toHaveBeenCalled()
})
