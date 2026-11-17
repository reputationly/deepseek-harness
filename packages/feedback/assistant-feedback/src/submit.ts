/**
 * Relay one feedback payload to the deployment's new-api site.
 *
 * The gateway serves model calls under `/v1`; the feedback endpoint sits beside that
 * prefix, so the path base is derived from the configured gateway root. Every failure
 * maps to one code the surface can name without guessing what the site meant.
 *
 * @module @deepseek-ai/dsh-assistant-feedback/submit
 */

import type { AssistantFeedbackFailureCode, AssistantFeedbackSubmitResult } from './types.ts'

/** Where and how to reach the feedback endpoint. */
export interface FeedbackEndpoint {
  /** Gateway root that carries the model API prefix. */
  readonly baseURL: string
  /** Key authorizing the submission. */
  readonly apiKey: string
  /** Request budget, milliseconds. */
  readonly timeoutMs: number
}

/**
 * Derive the feedback endpoint from the configured gateway root.
 * @param baseURL - gateway root, with or without its `/v1` prefix.
 * @returns the absolute feedback endpoint.
 */
export function feedbackEndpoint(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/u, '')
  const root = trimmed.endsWith('/v1') ? trimmed.slice(0, -'\/v1'.length) : trimmed
  return `${root}/api/assistant/feedback`
}

/**
 * Map an HTTP status to the code the surface reports.
 * @param status - response status.
 * @returns the matching failure code.
 */
function codeFor(status: number): AssistantFeedbackFailureCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 413) return 'too-large'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'unreachable'
  return 'rejected'
}

/**
 * Post one payload to the feedback endpoint.
 * @param endpoint - resolved endpoint, key, and budget.
 * @param body - JSON payload in the site's field names.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @returns the accepted record or an explicit failure.
 */
export async function postAssistantFeedback(
  endpoint: FeedbackEndpoint,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<AssistantFeedbackSubmitResult> {
  let response: Response
  try {
    response = await fetchImpl(feedbackEndpoint(endpoint.baseURL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: `连不上反馈服务：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) {
    // A 429 body may be empty, so the code alone explains it.
    return { ok: false, code: codeFor(response.status), message: `反馈服务返回 HTTP ${String(response.status)}` }
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return { ok: false, code: 'rejected', message: '反馈服务返回了无法解析的响应' }
  }
  const record = parsed !== null && typeof parsed === 'object' ? { ...parsed } as Record<string, unknown> : {}
  if (record.success !== true) {
    const message = typeof record.message === 'string' && record.message !== '' ? record.message : '反馈服务拒绝了这次提交'
    return { ok: false, code: 'rejected', message }
  }
  const data = record.data !== null && typeof record.data === 'object' ? { ...record.data } as Record<string, unknown> : {}
  const id = typeof data.id === 'number' ? data.id : 0
  const createdAt = typeof data.created_at === 'string' ? data.created_at : ''
  return { ok: true, id, createdAt }
}
