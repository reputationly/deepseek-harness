import { describe, expect, it } from 'vitest'
import { feedbackEndpoint, postAssistantFeedback } from '../src/submit.ts'

const endpoint = { baseURL: 'https://maas.example.com/v1', apiKey: 'sk-test', timeoutMs: 1000 }

/**
 * Build a fetch double answering once.
 * @param response - response to return.
 * @returns the double and the recorded arguments.
 */
function fetchReturning(response: Response): { impl: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, init })
    return response
  }
  return { impl, calls }
}

describe('feedbackEndpoint', () => {
  it('drops the model prefix and appends the feedback path', () => {
    expect(feedbackEndpoint('https://maas.example.com/v1')).toBe('https://maas.example.com/api/assistant/feedback')
    expect(feedbackEndpoint('https://maas.example.com/v1/')).toBe('https://maas.example.com/api/assistant/feedback')
    expect(feedbackEndpoint('https://maas.example.com')).toBe('https://maas.example.com/api/assistant/feedback')
  })
})

describe('postAssistantFeedback', () => {
  it('posts the payload with the gateway key and returns the accepted record', async () => {
    const { impl, calls } = fetchReturning(Response.json({ success: true, data: { id: 1024, created_at: '2026-11-14T14:40:00+08:00' } }, { status: 201 }))
    const result = await postAssistantFeedback(endpoint, { channel: 'general', content: 'hi' }, impl)
    expect(result).toEqual({ ok: true, id: 1024, createdAt: '2026-11-14T14:40:00+08:00' })
    expect(calls[0]?.url).toBe('https://maas.example.com/api/assistant/feedback')
    expect(calls[0]?.init?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' })
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ channel: 'general', content: 'hi' }))
  })

  it('maps refusal statuses to codes the surface names', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [413, 'too-large'], [429, 'rate-limited']] as const) {
      const { impl } = fetchReturning(new Response('', { status }))
      await expect(postAssistantFeedback(endpoint, {}, impl)).resolves.toMatchObject({ ok: false, code })
    }
  })

  it('reports the site sentence for a business rejection', async () => {
    const { impl } = fetchReturning(Response.json({ success: false, message: '意见反馈内容不能为空' }, { status: 200 }))
    await expect(postAssistantFeedback(endpoint, {}, impl)).resolves.toEqual({ ok: false, code: 'rejected', message: '意见反馈内容不能为空' })
  })

  it('treats an unreachable site as its own code', async () => {
    const impl: typeof fetch = async () => { throw new Error('ECONNREFUSED') }
    await expect(postAssistantFeedback(endpoint, {}, impl)).resolves.toMatchObject({ ok: false, code: 'unreachable' })
  })
})
