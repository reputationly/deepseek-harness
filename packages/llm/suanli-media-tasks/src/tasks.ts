/** Generation-task client for the deployment's gateway: submit, poll, cancel, download. */
import type {
  MediaCancelResult, MediaDownloadResult, MediaFailureReason, MediaOperation, MediaStatusResult,
  MediaSubmitRequest, MediaSubmitResult, MediaTaskState, MediaTransport,
} from './types.ts'

/** Paths one transport uses on an OpenAI-compatible gateway. */
export interface TransportPaths {
  /** Collection that creates a task, such as `/v1/videos`. */
  readonly collection: string
}

/** Inputs of one client. */
export interface MediaTaskClientOptions {
  /** Gateway origin or root that already carries its API prefix. */
  readonly baseURL: string
  /** Paths by transport. */
  readonly paths: Readonly<Record<MediaTransport, TransportPaths>>
  /** Request budget of one image call; image generation blocks until the artifact exists. */
  readonly imagesTimeoutMs: number
  /** Request budget of one video or music call; those answer with a task id. */
  readonly timeoutMs: number
  /** Interval between two status reads while waiting. */
  readonly pollIntervalMs: number
  /** Transport, injected so tests own their bytes. */
  readonly send: typeof fetch
  /** Resolve the gateway key. */
  readonly credential: () => Promise<string | undefined>
  /** Sleep between polls; injectable so tests do not wait in real time. */
  readonly sleep?: (ms: number) => Promise<void>
}

/** Gateway status words that mean a task finished successfully. */
const SUCCEEDED = new Set(['success', 'succeeded', 'SUCCESS', 'completed', 'COMPLETED'])
/** Gateway status words that mean a task failed. */
const FAILED = new Set(['failure', 'failed', 'FAILURE', 'CANCELLED', 'CANCELED', 'cancelled', 'canceled'])

/**
 * Normalize one gateway status word.
 * @param raw - status as the gateway reported it.
 * @returns the state this product renders.
 */
export function normalizeState(raw: unknown): MediaTaskState {
  if (typeof raw !== 'string') return 'running'
  const value = raw.trim()
  if (SUCCEEDED.has(value)) return 'succeeded'
  if (FAILED.has(value)) return 'failed'
  return 'running'
}

/** Transport one operation submits through. */
function transportOf(operation: MediaOperation): MediaTransport {
  return operation === 'generate_image' ? 'images' : 'videos'
}

/** JSON of one submit body. */
function bodyOf(request: MediaSubmitRequest): Record<string, unknown> {
  const references = request.referenceImages ?? []
  const images = references.length > 0 ? references : undefined
  const metadata: Record<string, unknown> = { ...request.params ?? {} }
  if (request.taskType !== undefined) metadata.task_type = request.taskType
  if (transportOf(request.operation) === 'videos') {
    return {
      model: request.model,
      prompt: request.prompt,
      ...images === undefined ? {} : { image: images[0], images },
      metadata,
    }
  }
  return {
    model: request.model,
    prompt: request.prompt,
    n: 1,
    ...images === undefined ? {} : { image: images },
    metadata,
  }
}

/** One gateway answer, decoded for the caller. */
type Answer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: MediaFailureReason; readonly detail?: string }

/**
 * Client for the gateway's generation-task transports.
 *
 * Both transports answer creation either with a finished artifact (an image endpoint may
 * answer synchronously) or with a task id to poll. A wait polls until the task reaches a
 * terminal state or the caller's deadline expires; cancellation is a caller decision, not a
 * timeout, so a deadline reports `timed-out` and leaves the task running.
 */
export class MediaTaskClient {
  constructor(private readonly options: MediaTaskClientOptions) {}

  /**
   * Submit one generation and report what the gateway answered.
   * @param request - operation, model, prompt, and parameters.
   * @param signal - caller cancellation.
   * @returns the task handle, or why no task exists.
   */
  async submit(request: MediaSubmitRequest, signal: AbortSignal): Promise<MediaSubmitResult> {
    const transport = transportOf(request.operation)
    const answer = await this.call('POST', this.options.paths[transport].collection, bodyOf(request), signal)
    if (!answer.ok) return answer
    const payload = answer.value
    const taskId = taskIdOf(payload)
    if (taskId === undefined) {
      const url = artifactOf(payload)
      if (url === undefined) return { ok: false, reason: 'rejected', detail: 'the gateway answered neither a task id nor an artifact' }
      return { ok: true, taskId: '', transport, state: 'succeeded', url }
    }
    return { ok: true, taskId, transport, state: normalizeState(statusOf(payload)), ...artworkOf(payload) }
  }

  /**
   * Read one task's state.
   * @param taskId - gateway task id.
   * @param transport - transport that submitted it.
   * @param signal - caller cancellation.
   * @returns the observation, or why it could not be read.
   */
  async status(taskId: string, transport: MediaTransport, signal: AbortSignal): Promise<MediaStatusResult> {
    const answer = await this.call('GET', `${this.options.paths[transport].collection}/${encodeURIComponent(taskId)}`, undefined, signal)
    if (!answer.ok) return answer
    const payload = answer.value
    const state = normalizeState(statusOf(payload))
    const error = errorOf(payload)
    const progress = progressOf(payload)
    return {
      ok: true,
      status: {
        taskId,
        state,
        ...artworkOf(payload),
        ...progress === undefined ? {} : { progress },
        ...error === undefined ? {} : { error },
      },
    }
  }

  /**
   * Poll one task until it reaches a terminal state or the deadline expires.
   * @param taskId - gateway task id.
   * @param transport - transport that submitted it.
   * @param options - deadline and caller cancellation.
   * @returns the terminal observation, or why the wait ended early.
   */
  async wait(
    taskId: string,
    transport: MediaTransport,
    options: { readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<MediaStatusResult> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
    const deadline = Date.now() + options.timeoutMs
    for (;;) {
      if (options.signal.aborted) return { ok: false, reason: 'cancelled' }
      const answer = await this.status(taskId, transport, options.signal)
      if (!answer.ok) return answer
      if (answer.status.state !== 'running') return answer
      if (Date.now() >= deadline) return { ok: false, reason: 'timed-out', detail: `task ${taskId} was still running` }
      await sleep(this.options.pollIntervalMs)
    }
  }

  /**
   * Ask the gateway to cancel one task.
   * @param taskId - gateway task id.
   * @param transport - transport that submitted it.
   * @param signal - caller cancellation.
   * @returns whether the gateway accepted the request.
   */
  async cancel(taskId: string, transport: MediaTransport, signal: AbortSignal): Promise<MediaCancelResult> {
    const answer = await this.call('DELETE', `${this.options.paths[transport].collection}/${encodeURIComponent(taskId)}`, undefined, signal)
    return answer.ok ? { ok: true } : { ok: false, reason: answer.reason, ...answer.detail === undefined ? {} : { detail: answer.detail } }
  }

  /**
   * Download a finished artifact to a caller-supplied path.
   * @param taskId - gateway task id.
   * @param transport - transport that submitted it.
   * @param targetPath - absolute path the caller owns.
   * @param signal - caller cancellation.
   * @returns the written path and size, or why nothing was written.
   */
  async download(taskId: string, transport: MediaTransport, targetPath: string, signal: AbortSignal): Promise<MediaDownloadResult> {
    const { writeFile } = await import('node:fs/promises')
    const key = await this.options.credential()
    if (key === undefined || key === '') return { ok: false, reason: 'no-credential' }
    const answer = await this.status(taskId, transport, signal)
    if (!answer.ok) return answer
    const url = answer.status.url
    if (url === undefined) return { ok: false, reason: 'no-artifact', detail: 'the task reported no artifact' }
    try {
      const budget = AbortSignal.timeout(this.options.imagesTimeoutMs)
      const response = await this.options.send(url, { signal: AbortSignal.any([signal, budget]) })
      if (!response.ok) return { ok: false, reason: 'unreachable', detail: `HTTP ${String(response.status)}` }
      const bytes = Buffer.from(await response.arrayBuffer())
      await writeFile(targetPath, bytes)
      return { ok: true, path: targetPath, bytes: bytes.byteLength }
    } catch {
      return { ok: false, reason: 'unreachable' }
    }
  }

  /**
   * Request budget for one path: image generation blocks until the artifact exists, while the
   * task transports answer with an id and poll separately.
   * @param path - collection path being called.
   * @returns the budget in milliseconds.
   */
  private budgetFor(path: string): number {
    return path.startsWith(this.options.paths.images.collection)
      ? this.options.imagesTimeoutMs
      : this.options.timeoutMs
  }

  /**
   * Save one artifact a caller already received (an image endpoint answers synchronously).
   * @param url - artifact URL the gateway reported.
   * @param targetPath - absolute path the caller owns.
   * @param signal - caller cancellation.
   * @returns the written path and size, or why nothing was written.
   */
  async save(url: string, targetPath: string, signal: AbortSignal): Promise<MediaDownloadResult> {
    const { writeFile } = await import('node:fs/promises')
    try {
      const budget = AbortSignal.timeout(this.options.imagesTimeoutMs)
      const response = await this.options.send(url, { signal: AbortSignal.any([signal, budget]) })
      if (!response.ok) return { ok: false, reason: 'unreachable', detail: `HTTP ${String(response.status)}` }
      const bytes = Buffer.from(await response.arrayBuffer())
      await writeFile(targetPath, bytes)
      return { ok: true, path: targetPath, bytes: bytes.byteLength }
    } catch {
      return { ok: false, reason: signal.aborted ? 'cancelled' : 'unreachable' }
    }
  }

  /** Perform one authenticated call and decode its JSON answer. */
  private async call(method: string, path: string, body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<Answer> {
    const key = await this.options.credential()
    if (key === undefined || key === '') return { ok: false, reason: 'no-credential' }
    let response: Response
    try {
      response = await this.options.send(new URL(path, this.options.baseURL).href, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          'x-api-key': key,
          accept: 'application/json',
          ...body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.budgetFor(path))]),
      })
    } catch {
      return { ok: false, reason: signal.aborted ? 'cancelled' : 'unreachable' }
    }
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'unauthorized' }
    if (response.status === 404) return { ok: false, reason: 'not-found' }
    if (!response.ok) return { ok: false, reason: 'rejected', detail: await errorTextOf(response) }
    if (method === 'DELETE') return { ok: true, value: undefined }
    try {
      return { ok: true, value: await response.json() }
    } catch {
      return { ok: false, reason: 'rejected', detail: 'the gateway answered no JSON' }
    }
  }
}

/** Failure text one refusal carries, preferring the gateway's own message. */
async function errorTextOf(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json()
    const error = (payload as { error?: { message?: unknown } } | null)?.error
    const message = error?.message
    return typeof message === 'string' && message !== '' ? message : `HTTP ${String(response.status)}`
  } catch {
    return `HTTP ${String(response.status)}`
  }
}

/** Task id of one creation answer, when the gateway created a task. */
function taskIdOf(payload: unknown): string | undefined {
  const value = (payload as { task_id?: unknown; id?: unknown } | null)
  const id = value?.task_id ?? value?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** Status word of one payload. */
function statusOf(payload: unknown): unknown {
  return (payload as { status?: unknown } | null)?.status
}

/** Artifact URL of one payload, from the shapes the gateway uses. */
function artifactOf(payload: unknown): string | undefined {
  const value = payload as { url?: unknown; data?: unknown; metadata?: { url?: unknown } } | null
  if (typeof value?.url === 'string' && value.url !== '') return value.url
  const reported = value?.metadata?.url
  if (typeof reported === 'string' && reported !== '') return reported
  if (Array.isArray(value?.data)) {
    const first = (value.data as readonly unknown[])[0]
    const url = (first as { url?: unknown } | undefined)?.url
    if (typeof url === 'string' && url !== '') return url
  }
  return undefined
}

/** Artifact URL as a status field, when the payload reported one. */
function artworkOf(payload: unknown): { url?: string } {
  const url = artifactOf(payload)
  return url === undefined ? {} : { url }
}

/** Completion percentage of one payload, when it reports a usable one. */
function progressOf(payload: unknown): number | undefined {
  const reported = (payload as { progress?: unknown } | null)?.progress
  return typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 && reported <= 100 ? reported : undefined
}

/** Failure text of one payload. */
function errorOf(payload: unknown): string | undefined {
  const error = (payload as { error?: { message?: unknown } | string } | null)?.error
  if (typeof error === 'string' && error !== '') return error
  const message = (error as { message?: unknown } | undefined)?.message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/** Transport of one operation, exposed for callers that render it. */
export function transportFor(operation: MediaOperation): MediaTransport {
  return transportOf(operation)
}
