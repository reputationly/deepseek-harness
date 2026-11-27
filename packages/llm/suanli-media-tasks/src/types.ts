/** Shapes the generation-task client reports to callers and to tests. */

/** Generation operations this deployment's catalog names. */
export type MediaOperation =
  | 'generate_image'
  | 'generate_video'
  | 'generate_music'

/** Transport one operation uses on the gateway. */
export type MediaTransport = 'images' | 'videos'

/** Why a task call produced no result. */
export type MediaFailureReason =
  | 'no-credential'
  | 'unauthorized'
  | 'not-found'
  | 'rejected'
  | 'unreachable'
  | 'timed-out'
  | 'cancelled'
  | 'no-artifact'

/** One submission: what to generate and with which parameters. */
export interface MediaSubmitRequest {
  /** Catalog operation that owns the model. */
  readonly operation: MediaOperation
  /** Wire model id. */
  readonly model: string
  /** Prompt the gateway forwards to the model. */
  readonly prompt: string
  /** Task type the operation needs, when the catalog declares several (`t2v`, `r2va`, `t2m`). */
  readonly taskType?: string
  /** Reference inputs; the catalog's `maxReferenceImages` bounds how many a class accepts. */
  readonly referenceImages?: readonly string[]
  /** Data URL of the clip a `video-extension` task continues. */
  readonly sourceVideo?: string
  /** Extra gateway parameters, forwarded verbatim. */
  readonly params?: Readonly<Record<string, string | number | boolean>>
  /** Image canvas as `WIDTHxHEIGHT`; the image route reads the canvas only from this field. */
  readonly size?: string
}

/** Terminal or in-flight state of one task. */
export type MediaTaskState = 'running' | 'succeeded' | 'failed' | 'cancelled'

/** One task observation. */
export interface MediaTaskStatus {
  /** Gateway task id. */
  readonly taskId: string
  /** Normalized state. */
  readonly state: MediaTaskState
  /** Artifact URL the gateway reported, when the task succeeded. */
  readonly url?: string
  /** Completion percentage the gateway reported, when it reports one. */
  readonly progress?: number
  /** Failure text the gateway reported, when the task failed. */
  readonly error?: string
}

/** Result of a submission. */
export type MediaSubmitResult =
  | {
    /** A task now exists; poll it with {@link MediaTaskStatus}. */
    readonly ok: true
    readonly taskId: string
    readonly transport: MediaTransport
    readonly state: MediaTaskState
    readonly url?: string
  }
  | { readonly ok: false; readonly reason: MediaFailureReason; readonly detail?: string }

/** Result of one status or terminal wait. */
export type MediaStatusResult =
  | { readonly ok: true; readonly status: MediaTaskStatus }
  | { readonly ok: false; readonly reason: MediaFailureReason; readonly detail?: string }

/** Result of a download. */
export type MediaDownloadResult =
  | { readonly ok: true; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: MediaFailureReason; readonly detail?: string }

/** Result of a cancellation request. */
export type MediaCancelResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: MediaFailureReason; readonly detail?: string }

/** One file a vision model looks at. */
export interface MediaInspectInput {
  /** Whether the chat request carries it as an image or a video part. */
  readonly kind: 'image' | 'video'
  /** Artifact URL or `data:<type>;base64,...` URL the chat endpoint can read. */
  readonly url: string
}

/** One question to a vision model about generated files. */
export interface MediaInspectRequest {
  /** Wire model id of the vision model. */
  readonly model: string
  /** What the model is asked about the files. */
  readonly instruction: string
  /** The files, in the order the instruction refers to them. */
  readonly media: readonly MediaInspectInput[]
}

/** The vision model's answer, or why there is none. */
export type MediaInspectResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: MediaFailureReason; readonly detail?: string }

/** One speech synthesis: the text to read and the voice parameters the catalog declares. */
export interface MediaSpeakRequest {
  /** Wire model id of the speech model. */
  readonly model: string
  /** Text read aloud. */
  readonly input: string
  /** Catalog parameters such as `voice`, by catalog key. */
  readonly params: Readonly<Record<string, string>>
}
