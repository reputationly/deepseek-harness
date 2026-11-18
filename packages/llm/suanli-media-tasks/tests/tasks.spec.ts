/** Generation-task client: submit, poll to a terminal state, cancel, download, and the failures around them. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaTaskClient, normalizeState } from '../src/tasks.ts'

const created: string[] = []
afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

function client(options: {
  readonly answer: (request: { method: string; url: string; body: unknown }) => Response | Promise<Response>
  readonly key?: string | undefined
  readonly pollIntervalMs?: number
}) {
  const calls: { method: string; url: string; body: unknown }[] = []
  const subject = new MediaTaskClient({
    baseURL: 'https://gateway.example',
    paths: { images: { collection: '/v1/images/generations' }, videos: { collection: '/v1/videos' } },
    timeoutMs: 1_000,
    pollIntervalMs: options.pollIntervalMs ?? 1,
    send: vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      const request = { method: init?.method ?? 'GET', url, body }
      calls.push(request)
      return await options.answer(request)
    }),
    credential: async () => options.key === undefined ? 'sk-test' : options.key,
    sleep: async () => {},
  })
  return { subject, calls }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

const signal = new AbortController().signal

describe('submit', () => {
  it('creates a video task with the declared task type', async () => {
    const { subject, calls } = client({ answer: () => json({ task_id: 'task-1', status: 'IN_PROGRESS' }) })
    await expect(subject.submit({ operation: 'generate_video', model: 'minimax-h3-2k', prompt: '走两步', taskType: 't2v' }, signal))
      .resolves.toEqual({ ok: true, taskId: 'task-1', transport: 'videos', state: 'running' })
    expect(calls[0]?.url).toBe('https://gateway.example/v1/videos')
    expect(calls[0]?.body).toMatchObject({ model: 'minimax-h3-2k', prompt: '走两步', metadata: { task_type: 't2v' } })
  })

  it('passes reference images to the video transport', async () => {
    const { subject, calls } = client({ answer: () => json({ task_id: 'task-2', status: 'QUEUED' }) })
    await subject.submit({ operation: 'generate_video', model: 'ref', prompt: 'p', taskType: 'r2va', referenceImages: ['a.png', 'b.png'] }, signal)
    expect(calls[0]?.body).toMatchObject({ image: 'a.png', images: ['a.png', 'b.png'] })
  })

  it('accepts a synchronous image answer as a finished artifact', async () => {
    const { subject, calls } = client({ answer: () => json({ data: [{ url: 'https://cdn.example/a.png' }] }) })
    await expect(subject.submit({ operation: 'generate_image', model: 'minimax-h3-image', prompt: '猫' }, signal))
      .resolves.toEqual({ ok: true, taskId: '', transport: 'images', state: 'succeeded', url: 'https://cdn.example/a.png' })
    expect(calls[0]?.url).toBe('https://gateway.example/v1/images/generations')
  })

  it.each([
    ['no-credential', { key: '' }],
  ] as const)('reports %s', async (reason, options) => {
    const { subject } = client({ answer: () => json({}), ...options })
    await expect(subject.submit({ operation: 'generate_image', model: 'm', prompt: 'p' }, signal)).resolves.toEqual({ ok: false, reason })
  })

  it('maps a refused request to the gateway message', async () => {
    const { subject } = client({ answer: () => json({ error: { message: 'model not configured' } }, 400) })
    await expect(subject.submit({ operation: 'generate_video', model: 'x', prompt: 'p' }, signal))
      .resolves.toEqual({ ok: false, reason: 'rejected', detail: 'model not configured' })
  })
})

describe('wait', () => {
  it('polls until the task succeeds', async () => {
    const states = ['QUEUED', 'IN_PROGRESS', 'SUCCESS']
    const { subject, calls } = client({
      answer: () => json({ task_id: 't', status: states.shift() ?? 'SUCCESS', url: 'https://cdn.example/v.mp4' }),
    })
    await expect(subject.wait('t', 'videos', { timeoutMs: 5_000, signal }))
      .resolves.toEqual({ ok: true, status: { taskId: 't', state: 'succeeded', url: 'https://cdn.example/v.mp4' } })
    expect(calls).toHaveLength(3)
  })

  it('reads the OpenAI video shape: progress, metadata url, completed', async () => {
    const answers = [
      { id: 't', status: 'queued', progress: 0, metadata: { url: '' } },
      { id: 't', status: 'in_progress', progress: 43, metadata: { url: '' } },
      { id: 't', status: 'completed', progress: 100, metadata: { url: 'https://cdn.example/v.mp4' } },
    ]
    const { subject } = client({ answer: () => json(answers.shift() ?? answers[answers.length - 1]) })
    await expect(subject.wait('t', 'videos', { timeoutMs: 5_000, signal })).resolves.toEqual({
      ok: true,
      status: { taskId: 't', state: 'succeeded', progress: 100, url: 'https://cdn.example/v.mp4' },
    })
  })

  it('reports a gateway failure with its message', async () => {
    const { subject } = client({ answer: () => json({ task_id: 't', status: 'FAILURE', error: { message: 'quota exceeded' } }) })
    await expect(subject.wait('t', 'videos', { timeoutMs: 5_000, signal }))
      .resolves.toEqual({ ok: true, status: { taskId: 't', state: 'failed', error: 'quota exceeded' } })
  })

  it('gives up at the deadline without cancelling the task', async () => {
    const { subject, calls } = client({ answer: () => json({ task_id: 't', status: 'IN_PROGRESS' }) })
    await expect(subject.wait('t', 'videos', { timeoutMs: 0, signal })).resolves.toMatchObject({ ok: false, reason: 'timed-out' })
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('stops when the caller cancels', async () => {
    const controller = new AbortController()
    controller.abort()
    const { subject, calls } = client({ answer: () => json({ task_id: 't', status: 'IN_PROGRESS' }) })
    await expect(subject.wait('t', 'videos', { timeoutMs: 5_000, signal: controller.signal }))
      .resolves.toMatchObject({ ok: false, reason: 'cancelled' })
    expect(calls).toHaveLength(0)
  })
})

describe('cancel and download', () => {
  it('asks the gateway to cancel', async () => {
    const { subject, calls } = client({ answer: () => new Response(null, { status: 204 }) })
    await expect(subject.cancel('t', 'videos', signal)).resolves.toEqual({ ok: true })
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: 'https://gateway.example/v1/videos/t' })
  })

  it('writes the artifact where the caller asked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-task-'))
    created.push(directory)
    const target = join(directory, 'out.mp4')
    const { subject } = client({
      answer: request => request.url.startsWith('https://cdn.example/')
        ? new Response(new Uint8Array([1, 2, 3]))
        : json({ task_id: 't', status: 'SUCCESS', url: 'https://cdn.example/out.mp4' }),
    })
    await expect(subject.download('t', 'videos', target, signal)).resolves.toEqual({ ok: true, path: target, bytes: 3 })
    expect([...await readFile(target)]).toEqual([1, 2, 3])
  })

  it('refuses to download a task that reported no artifact', async () => {
    const { subject } = client({ answer: () => json({ task_id: 't', status: 'IN_PROGRESS' }) })
    await expect(subject.download('t', 'videos', '/tmp/never-written', signal)).resolves.toMatchObject({ ok: false, reason: 'no-artifact' })
  })
})

describe('normalizeState', () => {
  it('reads the gateway words this product renders', () => {
    expect(normalizeState('SUCCESS')).toBe('succeeded')
    expect(normalizeState('succeeded')).toBe('succeeded')
    expect(normalizeState('FAILURE')).toBe('failed')
    expect(normalizeState('IN_PROGRESS')).toBe('running')
    expect(normalizeState(undefined)).toBe('running')
  })
})
