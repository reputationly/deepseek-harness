import { describe, expect, it, vi } from 'vitest'
import {
  MediaGatewayError, awaitTask, downloadMedia, editImage, generateImage, generateSpeech, readTask, submitTask,
} from '../src/gateway.ts'

const credential = { baseURL: 'https://gateway.example/v1/', apiKey: 'sk-test', signal: AbortSignal.timeout(5_000) }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

describe('image requests', () => {
  it('posts a generation request to the joined endpoint and returns the first URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [{ url: 'https://cdn.example/a.png' }] }))
    try {
      const url = await generateImage(credential, { model: 'qwen-image-pro', prompt: 'a cat', size: '1024x1024' })
      expect(url).toBe('https://cdn.example/a.png')
      expect(fetchSpy.mock.calls[0]![0]).toBe('https://gateway.example/v1/images/generations')
      expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual({
        model: 'qwen-image-pro', prompt: 'a cat', n: 1, size: '1024x1024',
      })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('surfaces the gateway message on failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: { message: 'bad model' } }, 400))
    try {
      await expect(generateImage(credential, { model: 'm', prompt: 'p' })).rejects.toThrow('bad model')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('accepts a base64 image response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [{ b64_json: 'AAAA' }] }))
    try {
      await expect(generateImage(credential, { model: 'm', prompt: 'p' })).resolves.toBe('data:image/png;base64,AAAA')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('rejects an image response with no payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [] }))
    try {
      await expect(generateImage(credential, { model: 'm', prompt: 'p' })).rejects.toThrow(/no image/u)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('edits an image with a multipart body and no explicit content type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ data: [{ url: 'https://cdn.example/b.png' }] }))
    try {
      const url = await editImage(credential, {
        model: 'm', prompt: 'p', image: new ArrayBuffer(4), filename: 'a.png', mimeType: 'image/png',
      })
      expect(url).toBe('https://cdn.example/b.png')
      const init = fetchSpy.mock.calls[0]![1]!
      expect(init.body).toBeInstanceOf(FormData)
      expect((init.headers as Record<string, string>)['content-type']).toBeUndefined()
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('speech requests', () => {
  it('returns inline audio bytes with the response content type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'audio/wav' },
    }))
    try {
      const audio = await generateSpeech(credential, { model: 'indextts-2.5', text: 'hi', voice: 'data:audio/wav;base64,AA' })
      expect(audio.contentType).toBe('audio/wav')
      expect([...audio.bytes]).toEqual([1, 2, 3])
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('follows a JSON audio response to its media URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [{ url: 'https://cdn.example/a.wav' }] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9])))
    try {
      const audio = await generateSpeech(credential, { model: 'm', text: 'hi', voice: 'v' })
      expect([...audio.bytes]).toEqual([9])
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('asynchronous tasks', () => {
  it('submits a task and reads its id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ id: 'task_1' }))
    try {
      await expect(submitTask(credential, 'minimax-music3', { instructions: 'calm piano' })).resolves.toBe('task_1')
      expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual({ model: 'minimax-music3', instructions: 'calm piano' })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it.each(['succeeded', 'success', 'completed', 'done'])('treats %s as finished', async (status) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status, url: 'https://cdn.example/v.mp4' }))
    try {
      await expect(readTask(credential, 't')).resolves.toEqual({ status: 'done', url: 'https://cdn.example/v.mp4' })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('reads the media URL from task metadata', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      status: 'completed', metadata: { url: 'https://cdn.example/m.wav' },
    }))
    try {
      await expect(readTask(credential, 't')).resolves.toEqual({ status: 'done', url: 'https://cdn.example/m.wav' })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('reports a finished task without media as an error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'succeeded' }))
    try {
      await expect(readTask(credential, 't')).rejects.toThrow(/without a media URL/u)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('reports failure with the gateway reason', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'failed', error: { message: 'bad input' } }))
    try {
      await expect(readTask(credential, 't')).resolves.toEqual({ status: 'failed', reason: 'bad input' })
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('polls until the task finishes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ status: 'in_progress', progress: 40 }))
      .mockResolvedValueOnce(json({ status: 'succeeded', url: 'https://cdn.example/v.mp4' }))
    try {
      await expect(awaitTask(credential, 't', { timeoutMs: 5_000, intervalMs: 1 })).resolves.toBe('https://cdn.example/v.mp4')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('fails when the task cannot finish inside the budget', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ status: 'in_progress', progress: 10 }))
    try {
      await expect(awaitTask(credential, 't', { timeoutMs: 5, intervalMs: 5 })).rejects.toThrow(/did not finish/u)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('fails a failed task through the await helper', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ status: 'failed', error: { message: 'nope' } }))
    try {
      await expect(awaitTask(credential, 't', { timeoutMs: 5_000, intervalMs: 1 })).rejects.toBeInstanceOf(MediaGatewayError)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('media download', () => {
  it('decodes a data URI without a request', async () => {
    const media = await downloadMedia(credential, 'data:audio/wav;base64,AQID')
    expect([...media.bytes]).toEqual([1, 2, 3])
    expect(media.contentType).toBe('audio/wav')
  })

  it('downloads an expiring URL with its content type', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([7]), {
      headers: { 'content-type': 'image/png' },
    }))
    try {
      const media = await downloadMedia(credential, 'https://cdn.example/a.png')
      expect(media.contentType).toBe('image/png')
      expect([...media.bytes]).toEqual([7])
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
