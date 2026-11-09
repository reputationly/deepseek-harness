/** Media gateway client: synchronous image and speech plus polled music and video tasks. */

/** One generated media file downloaded to disk. */
export interface MediaArtifact {
  /** Absolute path of the written file. */
  readonly path: string
  /** Gateway model that produced it. */
  readonly model: string
}

/** Transport options shared by every request. */
export interface GatewayRequest {
  readonly baseURL: string
  readonly apiKey: string
  readonly signal: AbortSignal
}

/** Failure reported by the gateway, carrying its HTTP status when one arrived. */
export class MediaGatewayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'MediaGatewayError'
  }
}

/** Request headers accepted by both bearer and API-key relays. */
function headers(request: GatewayRequest, contentType = 'application/json'): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': contentType,
    authorization: `Bearer ${request.apiKey}`,
    'x-api-key': request.apiKey,
  }
}

/** Strip trailing slashes so endpoint suffixes join once. */
function root(baseURL: string): string {
  return baseURL.replace(/\/+$/u, '')
}

/**
 * Read one error body into a short message.
 * @param response - failed response.
 * @returns the gateway's message, or the status text.
 */
async function failure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error = (parsed as { error?: unknown }).error
      if (typeof error === 'string') return error
      if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = (error as { message?: unknown }).message
        if (typeof message === 'string') return message
      }
    }
  } catch (_notJson: unknown) {
    // A non-JSON error body still yields the status text below.
  }
  return body.slice(0, 300) || response.statusText
}

/** Throw the gateway's message for a failed response. */
async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) throw new MediaGatewayError(await failure(response), response.status)
  return response
}

/** One `{url}` image entry from an image response. */
async function imageURL(response: Response): Promise<string> {
  const body = await (await ensureOk(response)).json() as { data?: Array<{ url?: string; b64_json?: string }> }
  const first = body.data?.[0]
  if (first?.url !== undefined && first.url !== '') return first.url
  if (first?.b64_json !== undefined && first.b64_json !== '') return `data:image/png;base64,${first.b64_json}`
  throw new MediaGatewayError('gateway returned no image')
}

/**
 * Generate one image from text.
 * @param request - endpoint and credential.
 * @param input - model, prompt, size, and count.
 * @returns a downloadable URL or data URI.
 */
export async function generateImage(
  request: GatewayRequest,
  input: { model: string; prompt: string; size?: string; count?: number },
): Promise<string> {
  const response = await fetch(`${root(request.baseURL)}/images/generations`, {
    method: 'POST',
    headers: headers(request),
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      n: input.count ?? 1,
      ...(input.size === undefined ? {} : { size: input.size }),
    }),
    signal: request.signal,
  })
  return imageURL(response)
}

/**
 * Edit one image from a prompt and a source file.
 * @param request - endpoint and credential.
 * @param input - model, prompt, and the source image bytes.
 * @returns a downloadable URL or data URI.
 */
export async function editImage(
  request: GatewayRequest,
  input: { model: string; prompt: string; image: ArrayBuffer; filename: string; mimeType: string },
): Promise<string> {
  const form = new FormData()
  form.set('model', input.model)
  form.set('prompt', input.prompt)
  form.set('image', new Blob([input.image], { type: input.mimeType }), input.filename)
  // Multipart bodies must not carry an explicit content-type: fetch owns the boundary.
  const { 'content-type': _omitted, ...authHeaders } = headers(request)
  const response = await fetch(`${root(request.baseURL)}/images/edits`, {
    method: 'POST',
    headers: authHeaders,
    body: form,
    signal: request.signal,
  })
  return imageURL(response)
}

/**
 * Edit or combine reference images through the JSON form of the edits endpoint.
 * @param request - gateway credential and cancellation.
 * @param input - model, instruction, and reference images as data URIs or URLs.
 * @returns the first result URL or data URI.
 */
export async function editImages(
  request: GatewayRequest,
  input: { model: string; prompt: string; images: readonly string[] },
): Promise<string> {
  const response = await fetch(`${root(request.baseURL)}/images/edits`, {
    method: 'POST',
    headers: headers(request),
    body: JSON.stringify({ model: input.model, prompt: input.prompt, images: [...input.images] }),
    signal: request.signal,
  })
  return imageURL(response)
}

/**
 * Synthesize speech from text.
 * @param request - endpoint and credential.
 * @param input - model, text, and the reference voice source.
 * @returns audio bytes and the response content type.
 */
export async function generateSpeech(
  request: GatewayRequest,
  input: { model: string; text: string; voice: string; format?: string },
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await ensureOk(await fetch(`${root(request.baseURL)}/audio/speech`, {
    method: 'POST',
    headers: headers(request),
    body: JSON.stringify({
      model: input.model,
      input: input.text,
      voice: input.voice,
      ...(input.format === undefined ? {} : { response_format: input.format }),
    }),
    signal: request.signal,
  }))
  const contentType = response.headers.get('content-type') ?? 'audio/mpeg'
  if (contentType.includes('application/json')) {
    const body = await response.json() as { data?: Array<{ url?: string }> }
    const url = body.data?.[0]?.url
    if (url === undefined) throw new MediaGatewayError('gateway returned no audio')
    const audio = await ensureOk(await fetch(url, { signal: request.signal }))
    return { bytes: new Uint8Array(await audio.arrayBuffer()), contentType: 'audio/mpeg' }
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType }
}

/** Async media task state reported by the gateway. */
export type TaskState =
  | { readonly status: 'pending'; readonly progress: number }
  | { readonly status: 'done'; readonly url: string }
  | { readonly status: 'failed'; readonly reason: string }

/**
 * Submit one asynchronous music or video task.
 * @param request - endpoint and credential.
 * @param model - gateway model id.
 * @param body - model-specific request fields.
 * @returns the gateway task id.
 */
export async function submitTask(request: GatewayRequest, model: string, body: Record<string, unknown>): Promise<string> {
  const response = await ensureOk(await fetch(`${root(request.baseURL)}/videos`, {
    method: 'POST',
    headers: headers(request),
    body: JSON.stringify({ model, ...body }),
    signal: request.signal,
  }))
  const parsed = await response.json() as { id?: string; task_id?: string }
  const id = parsed.id ?? parsed.task_id
  if (id === undefined || id === '') throw new MediaGatewayError('gateway returned no task id')
  return id
}

/**
 * Read one asynchronous task.
 * @param request - endpoint and credential.
 * @param id - gateway task id.
 * @returns normalized task state.
 */
export async function readTask(request: GatewayRequest, id: string): Promise<TaskState> {
  const response = await ensureOk(await fetch(`${root(request.baseURL)}/videos/${encodeURIComponent(id)}`, {
    headers: headers(request),
    signal: request.signal,
  }))
  const body = await response.json() as {
    status?: string
    progress?: number
    url?: string
    content_url?: string
    result_url?: string
    metadata?: { url?: string }
    data?: { url?: string; result_url?: string }
    error?: { message?: string }
  }
  const status = body.status ?? 'pending'
  if (status === 'succeeded' || status === 'success' || status === 'completed' || status === 'done') {
    const url = body.url ?? body.content_url ?? body.result_url
      ?? body.metadata?.url ?? body.data?.url ?? body.data?.result_url
    if (url === undefined) throw new MediaGatewayError('gateway finished without a media URL')
    return { status: 'done', url }
  }
  if (status === 'failed' || status === 'failure' || status === 'cancelled') {
    return { status: 'failed', reason: body.error?.message ?? 'gateway reported failure' }
  }
  return { status: 'pending', progress: body.progress ?? 0 }
}

/**
 * Wait for one asynchronous task to finish.
 * @param request - endpoint and credential.
 * @param id - gateway task id.
 * @param options - total budget and polling interval.
 * @returns the finished media URL.
 */
export async function awaitTask(
  request: GatewayRequest,
  id: string,
  options: { timeoutMs: number; intervalMs: number },
): Promise<string> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const state = await readTask(request, id)
    if (state.status === 'done') return state.url
    if (state.status === 'failed') throw new MediaGatewayError(state.reason)
    if (Date.now() + options.intervalMs > deadline) {
      throw new MediaGatewayError(`task ${id} did not finish within ${String(options.timeoutMs)}ms`)
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.intervalMs)
      request.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    if (request.signal.aborted) throw new MediaGatewayError('cancelled')
  }
}

/**
 * Download one media URL or data URI to disk.
 * @param request - endpoint and credential.
 * @param url - media URL or `data:` URI.
 * @returns the bytes and their content type.
 */
export async function downloadMedia(request: GatewayRequest, url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (url.startsWith('data:')) {
    const [meta, payload] = url.slice(5).split(',', 2)
    const contentType = meta?.split(';')[0] || 'application/octet-stream'
    return { bytes: new Uint8Array(Buffer.from(payload ?? '', 'base64')), contentType }
  }
  const response = await ensureOk(await fetch(url, { signal: request.signal }))
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  }
}
