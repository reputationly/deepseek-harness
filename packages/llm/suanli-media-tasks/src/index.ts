/**
 * Host Remote namespace that drives this deployment's generation tasks.
 *
 * The gateway exposes OpenAI-compatible task transports: images under
 * `/v1/images/generations` and video or music under `/v1/videos`. A submission answers either
 * with a finished artifact or a task id to poll; this service owns the credential, the polling
 * cadence, and the cancellation, so the browser never holds the key.
 *
 * @module @deepseek-ai/dsh-suanli-media-tasks
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  DEFAULT_IMAGES_PATH, DEFAULT_MEDIA_IMAGE_TIMEOUT_MS, DEFAULT_MEDIA_POLL_MS, DEFAULT_MEDIA_TIMEOUT_MS,
  DEFAULT_VIDEOS_PATH,
} from './defaults.ts'
import { MediaTaskClient, transportFor } from './tasks.ts'
import type {
  MediaCancelResult, MediaDownloadResult, MediaOperation, MediaStatusResult, MediaSubmitRequest, MediaSubmitResult,
  MediaInspectRequest, MediaInspectResult, MediaSpeakRequest, MediaTransport,
} from './types.ts'

export type * from './types.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `suanliMedia` Remote namespace. */
    suanliMedia: SuanliMediaTasksService
  }
}

/** Deployment facts one generation call needs. */
export interface Config {
  /** Gateway root that already carries its API prefix. */
  readonly baseURL: string
  /** Credential reference holding the gateway key. */
  readonly apiKeyEnv: string
  /** Image collection path (default `/v1/images/generations`). */
  readonly imagesPath?: string
  /** Video and music collection path (default `/v1/videos`). */
  readonly videosPath?: string
  /** Request budget of one task-transport call, in milliseconds. */
  readonly timeoutMs?: number
  /** Request budget of one image call, in milliseconds; image generation blocks until the file exists. */
  readonly imagesTimeoutMs?: number
  /** Interval between two status reads, in milliseconds. */
  readonly pollIntervalMs?: number
}

/** Host service backing the generated `ctx.remote.suanliMedia` namespace. */
export class SuanliMediaTasksService extends TypertRemoteService {
  static inject = ['credentials', 'typert']

  static Config: z<Config> = z.object({
    baseURL: z.string().min(1),
    apiKeyEnv: z.string().role('credential-ref').min(1),
    imagesPath: z.string().pattern(/^\//u).default(DEFAULT_IMAGES_PATH),
    videosPath: z.string().pattern(/^\//u).default(DEFAULT_VIDEOS_PATH),
    timeoutMs: z.natural().min(1).default(DEFAULT_MEDIA_TIMEOUT_MS),
    imagesTimeoutMs: z.natural().min(1).default(DEFAULT_MEDIA_IMAGE_TIMEOUT_MS),
    pollIntervalMs: z.natural().min(1).default(DEFAULT_MEDIA_POLL_MS),
  })

  private readonly ref: CredentialRef
  private readonly client: MediaTaskClient

  /**
   * @param ctx - Host context carrying the credential provider and the Typert registry.
   * @param config - gateway endpoint, credential reference, and call budgets.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'suanliMedia', { namespace: 'suanliMedia' })
    this.ref = credentialRef(config.apiKeyEnv)
    this.client = new MediaTaskClient({
      baseURL: config.baseURL,
      paths: {
        images: { collection: config.imagesPath ?? DEFAULT_IMAGES_PATH },
        videos: { collection: config.videosPath ?? DEFAULT_VIDEOS_PATH },
      },
      timeoutMs: config.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS,
      imagesTimeoutMs: config.imagesTimeoutMs ?? DEFAULT_MEDIA_IMAGE_TIMEOUT_MS,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_MEDIA_POLL_MS,
      send: (input, init) => fetch(input, init),
      credential: async () => {
        const stored = await this.ctx.credentials.resolve(this.ref)
        return stored?.value
      },
    })
  }

  /**
   * Submit one generation.
   * @param request - operation, model, prompt, and parameters.
   * @returns the task handle, or why no task exists.
   */
  @Remote
  async submit(request: MediaSubmitRequest): Promise<MediaSubmitResult> {
    return await this.client.submit(request, new AbortController().signal)
  }

  /**
   * Read one task's state.
   * @param taskId - gateway task id.
   * @param operation - operation that submitted it; the transport follows from it.
   * @returns the observation, or why it could not be read.
   */
  @Remote
  async status(taskId: string, operation: MediaOperation): Promise<MediaStatusResult> {
    return await this.client.status(taskId, transportFor(operation), new AbortController().signal)
  }

  /**
   * Poll one task until it finishes.
   * @param taskId - gateway task id.
   * @param operation - operation that submitted it.
   * @param timeoutMs - how long the caller will wait.
   * @returns the terminal observation, or why the wait ended early.
   */
  @Remote
  async wait(taskId: string, operation: MediaOperation, timeoutMs: number): Promise<MediaStatusResult> {
    return await this.client.wait(taskId, transportFor(operation), { timeoutMs, signal: new AbortController().signal })
  }

  /**
   * Ask the gateway to cancel one task.
   * @param taskId - gateway task id.
   * @param operation - operation that submitted it.
   * @returns whether the gateway accepted the request.
   */
  @Remote
  async cancel(taskId: string, operation: MediaOperation): Promise<MediaCancelResult> {
    return await this.client.cancel(taskId, transportFor(operation), new AbortController().signal)
  }

  /**
   * Save an artifact URL a caller already received; image generation answers synchronously.
   * @param url - artifact URL the gateway reported.
   * @param targetPath - absolute path inside the caller's workspace.
   * @returns the written path and size, or why nothing was written.
   */
  @Remote
  async saveArtifact(url: string, targetPath: string): Promise<MediaDownloadResult> {
    return await this.client.save(url, targetPath, new AbortController().signal)
  }

  /**
   * Ask a vision model one question about generated files.
   * @param request - vision model, instruction, and the inlined files.
   * @returns the answer text, or why there is none.
   */
  @Remote
  async inspect(request: MediaInspectRequest): Promise<MediaInspectResult> {
    return await this.client.inspect(request, new AbortController().signal)
  }

  /**
   * Synthesize speech and write the audio to a path the caller owns.
   * @param request - speech model, text, and catalog parameters.
   * @param targetPath - absolute path the caller owns.
   * @returns the written path and size, or why nothing was written.
   */
  @Remote
  async speak(request: MediaSpeakRequest, targetPath: string): Promise<MediaDownloadResult> {
    return await this.client.speak(request, targetPath, new AbortController().signal)
  }

  /**
   * Download a finished artifact to a path the caller owns.
   * @param taskId - gateway task id.
   * @param operation - operation that submitted it.
   * @param targetPath - absolute path inside the caller's workspace.
   * @returns the written path and size, or why nothing was written.
   */
  @Remote
  async download(taskId: string, operation: MediaOperation, targetPath: string): Promise<MediaDownloadResult> {
    return await this.client.download(taskId, transportFor(operation), targetPath, new AbortController().signal)
  }
}

export default SuanliMediaTasksService

/** Transport of one operation, re-exported for the composition's row documentation. */
export type { MediaTransport }
