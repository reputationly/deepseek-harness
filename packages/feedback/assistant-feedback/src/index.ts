/**
 * Host namespace relaying assistant feedback to the deployment's new-api site.
 *
 * The gateway key lives in this process, so the browser never carries it: the Client
 * calls `remote.assistantFeedback.submit` and this service adds the credential, the
 * platform facts, and the redacted conversation snapshot the site stores.
 *
 * @module @deepseek-ai/dsh-assistant-feedback
 */

import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { buildSnapshot, DEFAULT_MAX_TURNS } from './snapshot.ts'
import { DEFAULT_MAX_CONTEXT_BYTES, DEFAULT_TIMEOUT_MS } from './defaults.ts'
import { resolveRequestId } from './request-id.ts'
import { postAssistantFeedback } from './submit.ts'
import type { AssistantFeedbackSubmitRequest, AssistantFeedbackSubmitResult } from './types.ts'

export type { SnapshotOptions } from './snapshot.ts'
export type { FeedbackEndpoint } from './submit.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `assistantFeedback` Remote namespace. */
    assistantFeedback: AssistantFeedbackService
  }
}

/** Where submissions go and how much conversation they may carry. */
export interface Config {
  /** Gateway root that carries its API prefix; the feedback endpoint is derived from it. */
  readonly baseURL: string
  /** Credential reference holding the gateway key; resolved at every submission. */
  readonly apiKeyEnv: string
  /** Request budget per submission, in milliseconds. */
  readonly timeoutMs?: number
  /** Serialized byte ceiling for the attached snapshot. */
  readonly maxContextBytes?: number
  /** Newest turns kept before the byte ceiling applies. */
  readonly maxTurns?: number
}

/** Host service backing the generated `ctx.remote.assistantFeedback` namespace. */
export class AssistantFeedbackService extends TypertRemoteService {
  static inject = ['credentials', 'sessions', 'typert']

  static Config: s<Config> = s.object({
    baseURL: s.string().min(1).required(),
    apiKeyEnv: s.string().role('credential-ref').min(1).required(),
    timeoutMs: s.natural().min(1).default(DEFAULT_TIMEOUT_MS),
    maxContextBytes: s.natural().min(1).default(DEFAULT_MAX_CONTEXT_BYTES),
    maxTurns: s.natural().min(1).default(DEFAULT_MAX_TURNS),
  })

  private readonly ref: CredentialRef
  private readonly timeoutMs: number
  private readonly maxContextBytes: number
  private readonly maxTurns: number
  private readonly baseURL: string

  /**
   * @param ctx - Host context carrying the credential provider and live Sessions.
   * @param config - gateway root, credential reference, and snapshot limits.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'assistantFeedback', { namespace: 'assistantFeedback' })
    this.baseURL = config.baseURL
    this.ref = credentialRef(config.apiKeyEnv)
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxContextBytes = config.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES
    this.maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS
  }

  /**
   * Relay one submission, attaching the redacted snapshot of its Session.
   * @param request - channel, verdict, user text, and the targets it names.
   * @returns the accepted record or an explicit failure the surface reports unchanged.
   */
  @Remote('submit')
  async submit(request: AssistantFeedbackSubmitRequest): Promise<AssistantFeedbackSubmitResult> {
    if (request.channel === 'rating' && request.rating === undefined) {
      return { ok: false, code: 'rejected', message: '评价缺少赞或踩的取值' }
    }
    if (request.channel === 'general' && (request.content ?? '').trim() === '') {
      return { ok: false, code: 'rejected', message: '意见反馈内容不能为空' }
    }
    const stored = await this.ctx.credentials.resolve(this.ref)
    const apiKey = stored?.value.trim() ?? ''
    if (apiKey === '') return { ok: false, code: 'no-key', message: '还没有配置网关 API Key' }
    const body = this.payload(request)
    return postAssistantFeedback({ baseURL: this.baseURL, apiKey, timeoutMs: this.timeoutMs }, body)
  }

  /**
   * Build the site's request fields.
   * @param request - what the Client asked to submit.
   * @returns the JSON payload, with the snapshot only where the request named a Session.
   */
  private payload(request: AssistantFeedbackSubmitRequest): Record<string, unknown> {
    const events = request.sessionId === undefined ? undefined : this.eventsOf(request.sessionId)
    const snapshot = events === undefined || request.attachContext === false
      ? undefined
      : buildSnapshot(events, {
        maxBytes: this.maxContextBytes,
        maxTurns: this.maxTurns,
        ...request.messageId === undefined ? {} : { targetMessageId: request.messageId },
      })
    const requestId = resolveRequestId(events ?? [], request.messageId, request.requestId)
    return {
      channel: request.channel,
      ...request.channel === 'rating' && request.rating !== undefined ? { rating: request.rating } : {},
      ...request.category === undefined ? {} : { category: request.category },
      ...request.content === undefined || request.content.trim() === '' ? {} : { content: request.content },
      ...request.contact === undefined || request.contact.trim() === '' ? {} : { contact: request.contact },
      ...request.sessionId === undefined ? {} : { session_id: request.sessionId },
      ...request.messageId === undefined ? {} : { message_id: request.messageId },
      ...requestId === undefined ? {} : { request_id: requestId },
      ...request.model === undefined ? {} : { model: request.model },
      ...process.env.DSH_CLIENT_VERSION === undefined ? {} : { client_version: process.env.DSH_CLIENT_VERSION },
      ...request.platform === undefined ? {} : { platform: request.platform },
      ...request.deviceInfo === undefined ? {} : { device_info: request.deviceInfo },
      ...snapshot === undefined ? {} : { context: snapshot },
    }
  }

  /**
   * Read the live Session's events, the one source for both the snapshot and the request id.
   * @param sessionId - Session the submission names.
   * @returns its events, or undefined when this Host does not hold the Session.
   */
  private eventsOf(sessionId: SessionId): readonly SessionEvent[] | undefined {
    const live = this.ctx.sessions.get(sessionId)
    if (live === undefined) return undefined
    // A snapshot is a reply-time read of the log rather than hot-path state, and the Session
    // projection that would replace it does not exist yet; message-feedback makes the same read.
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return live.snapshotEvents()
  }
}

export default AssistantFeedbackService
