/** `generate_video` and `generate_music`: catalog-driven parameters, one task, and the saved file. */

import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityEntry, CapabilityMode } from '@deepseek-ai/dsh-suanli-model-catalog/types'
import type { MediaFailureReason, MediaOperation } from '@deepseek-ai/dsh-suanli-media-tasks/types'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-suanli-model-catalog'
import { review } from './review.ts'
import { fingerprint, type PendingTasks } from './pending.ts'
import { failure, outputDirectory, resolveParameters, saveArtifact, workspaceOf } from './common.ts'
import { ASPECT, AUDIO, DURATION, INSTRUMENTAL, RESOLUTION, type ParameterKind } from './params.ts'
import type { MediaResultMeta } from './types.ts'

/** Longest a video may render before the call gives up; the task keeps running at the gateway. */
const VIDEO_WAIT_MS = 20 * 60_000
/** Longest a song may render. */
const MUSIC_WAIT_MS = 10 * 60_000
/** One status poll; a stop is noticed within this much time. */
const POLL_MS = 10_000
/** Wait failures after which the task can no longer deliver; any other failure leaves it resumable. */
const GONE: ReadonlySet<MediaFailureReason> = new Set(['not-found', 'rejected', 'cancelled', 'no-artifact'])
/** Largest image a frame or reference may be. */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
/** Largest clip the gateway continues. */
const MAX_SOURCE_VIDEO_BYTES = 50 * 1024 * 1024

/** Arguments of `generate_video`. */
interface VideoArgs {
  readonly prompt: string
  readonly aspect_ratio?: string | undefined
  readonly resolution?: string | undefined
  readonly duration_seconds?: number | undefined
  readonly with_audio?: boolean | undefined
  readonly first_frame?: string | undefined
  readonly last_frame?: string | undefined
  readonly reference_images?: readonly string[] | undefined
  readonly source_video?: string | undefined
}

/** Arguments of `generate_music`. */
interface MusicArgs {
  readonly prompt: string
  readonly lyrics?: string | undefined
  readonly instrumental?: boolean | undefined
}

/** Read the exact direct-user request hash current in one Session, when projection state is available. */
export type UserTextHashOf = (session: NonNullable<ToolExecution['agent']>['session']) => string | undefined

/** What one execution resolved before submission. */
interface Plan {
  readonly entry: CapabilityEntry
  readonly modelLabel: string
  readonly taskType?: string
  readonly references: readonly string[]
  readonly sourceVideo?: string
  readonly extra: Readonly<Record<string, string>>
}

/** Result value both tools return. */
export interface MediaValue {
  readonly status: 'generated' | 'cancelled'
  readonly prompt: string
  readonly model: string
  readonly modelLabel: string
  readonly parameters: { key: string; value: string }[]
  readonly media: { path: string; mediaType: string }[]
  readonly review?: { verdict: 'match' | 'partial' | 'mismatch'; reason: string }
}

const videoDescription = 'Generate a video clip from a text description, optionally from a first (and last) frame '
  + 'or from reference images in the workspace, or continue a workspace clip. Pass the user\'s own words for aspect ratio, resolution, duration, '
  + 'and sound when they give them (for example "竖屏", "2K", 10, true); leave them out otherwise. The tool asks the '
  + 'user for anything missing or unsupported, so do not ask first. Rendering takes minutes; call it once.'

const musicDescription = 'Generate a piece of music from a description of its style and mood, optionally with lyrics. '
  + 'Pass instrumental only when the user said whether the piece has vocals; the tool asks otherwise, so do not ask first.'

/**
 * Build the `generate_video` definition.
 * @param ctx - plugin context.
 * @param pending - unsettled tasks a repeated call resumes.
 * @param userTextHashOf - projected direct-user prompt-hash reader.
 * @returns the tool.
 */
export function videoTool(ctx: Context, pending: PendingTasks, userTextHashOf: UserTextHashOf) {
  return defineTool({
    name: 'generate_video',
    description: videoDescription,
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the clip shows and how it moves, in the user\'s language.' },
      aspect_ratio: { type: 'string', description: 'Aspect ratio in the user\'s words, such as "9:16" or "竖屏". Omit when the user gave none.' },
      resolution: { type: 'string', description: 'Resolution in the user\'s words, such as "2K". Omit when the user gave none.' },
      duration_seconds: { type: 'number', description: 'Length in seconds the user asked for. Omit when the user gave none.' },
      with_audio: { type: 'boolean', description: 'Whether the clip has sound, when the user said so. Omit otherwise.' },
      first_frame: { type: 'string', description: 'Workspace path of the image the clip starts from.' },
      last_frame: { type: 'string', description: 'Workspace path of the image the clip ends on; needs first_frame.' },
      reference_images: {
        type: 'array', items: { type: 'string' },
        description: 'Workspace paths of images whose subjects or style the clip should follow; not combined with frames.',
      },
      source_video: {
        type: 'string',
        description: 'Workspace path of a clip to continue; duration_seconds is then the total length. Not combined with images.',
      },
    },
    output: outputOf(),
    timeoutMs: VIDEO_WAIT_MS + 600_000,
    async execute(args, exec) {
      return await generate(ctx, pending, userTextHashOf, 'Video', 'generate_video', 'video', VIDEO_WAIT_MS, args.prompt, exec,
        async (entries, preferred, cwd) => await planVideo(ctx, pending, entries, preferred, cwd, args, exec.signal),
        [[ASPECT, args.aspect_ratio], [RESOLUTION, args.resolution],
          [DURATION, args.duration_seconds === undefined ? undefined : String(args.duration_seconds)],
          [AUDIO, args.with_audio === undefined ? undefined : String(args.with_audio)]])
    },
  })
}

/**
 * Build the `generate_music` definition.
 * @param ctx - plugin context.
 * @param pending - unsettled tasks a repeated call resumes.
 * @param userTextHashOf - projected direct-user prompt-hash reader.
 * @returns the tool.
 */
export function musicTool(ctx: Context, pending: PendingTasks, userTextHashOf: UserTextHashOf) {
  return defineTool({
    name: 'generate_music',
    description: musicDescription,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Style, mood, instruments, and tempo, in the user\'s language.' },
      lyrics: { type: 'string', description: 'Lyrics the user wrote or asked for; omit for an instrumental piece.' },
      instrumental: { type: 'boolean', description: 'true for no vocals, false for a song, when the user said so. Omit otherwise.' },
    },
    output: outputOf(),
    timeoutMs: MUSIC_WAIT_MS + 600_000,
    async execute(args, exec) {
      return await generate(ctx, pending, userTextHashOf, 'Music', 'generate_music', 'music', MUSIC_WAIT_MS, args.prompt, exec,
        (entries, preferred) => Promise.resolve(planMusic(ctx, entries, preferred, args)),
        [[INSTRUMENTAL, args.instrumental === undefined ? undefined : String(args.instrumental)]])
    },
  })
}

/**
 * Output schema, model text, and card metadata both tools share.
 * @returns the output definition.
 */
export function outputOf() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true, enum: ['generated', 'cancelled'] },
        prompt: { type: 'string', required: true },
        model: { type: 'string', required: true },
        modelLabel: { type: 'string', required: true },
        review: {
          type: 'object', additionalProperties: false,
          properties: {
            verdict: { type: 'string', required: true, enum: ['match', 'partial', 'mismatch'] },
            reason: { type: 'string', required: true },
          },
        },
        parameters: {
          type: 'array', required: true,
          items: {
            type: 'object', additionalProperties: false,
            properties: { key: { type: 'string', required: true }, value: { type: 'string', required: true } },
          },
        },
        media: {
          type: 'array', required: true,
          items: {
            type: 'object', additionalProperties: false,
            properties: { path: { type: 'string', required: true }, mediaType: { type: 'string', required: true } },
          },
        },
      },
    } as const,
    render: (_args: unknown, value: MediaValue) => [{
      type: 'text' as const,
      text: value.status === 'cancelled'
        ? 'The user cancelled the generation; nothing was submitted.'
        : JSON.stringify({
          status: value.status,
          model: value.model,
          parameters: Object.fromEntries(value.parameters.map(entry => [entry.key, entry.value])),
          files: value.media.map(item => item.path),
          ...value.review !== undefined ? { review: value.review } : {},
        }),
    }],
    presentationMeta: (_args: unknown, value: MediaValue): JsonValue => ({
      status: value.status,
      prompt: value.prompt,
      model: value.model,
      modelLabel: value.modelLabel,
      parameters: Object.fromEntries(value.parameters.map(entry => [entry.key, entry.value])),
      media: value.media.map(item => ({ path: item.path, mediaType: item.mediaType })),
      ...value.review !== undefined ? { review: value.review } : {},
      keepTurnOpen: true,
    } satisfies MediaResultMeta),
  }
}

/**
 * Run one generation: plan, settle parameters, submit, wait, and save.
 * @param ctx - plugin context.
 * @param pending - unsettled tasks; an identical request resumes its task instead of submitting again.
 * @param userTextHashOf - projected direct-user prompt-hash reader.
 * @param what - which generation, for errors.
 * @param operation - catalog operation.
 * @param role - model role whose choice is preferred.
 * @param budgetMs - longest the call waits for the task.
 * @param prompt - what the user asked for.
 * @param exec - the execution.
 * @param plan - pick the entry and inputs among the operation's entries.
 * @param requested - each parameter with the value the call carries.
 * @returns the canonical result.
 * @throws When no model fits, the gateway refused, or the file could not be saved.
 */
async function generate(
  ctx: Context, pending: PendingTasks, userTextHashOf: UserTextHashOf, what: string, operation: MediaOperation, role: 'video' | 'music', budgetMs: number, prompt: string,
  exec: ToolExecution, plan: (entries: readonly CapabilityEntry[], preferred: string | null, cwd: string) => Promise<Plan>,
  requested: readonly (readonly [ParameterKind, string | undefined])[],
): Promise<MediaValue> {
  const state = ctx.suanliModels.roles().find(item => item.role === role)
  const entries = ctx.suanliModels.media().entries.filter(item => item.operation === operation)
  if (state === undefined || entries.length === 0) throw new Error(`No ${role} model is available in the gateway catalog.`)
  const cwd = await workspaceOf(ctx, exec)
  const chosen = await plan(entries, state.selected ?? state.fallback, cwd)
  const model = chosen.entry.model
  const base = { prompt, model, modelLabel: chosen.modelLabel }
  const parameters = await resolveParameters(ctx, chosen.entry, requested, exec)
  if (parameters === undefined) return { ...base, status: 'cancelled', parameters: [], media: [] }
  const merged = { ...parameters, ...chosen.extra }
  const { lyrics, ...rest } = merged
  const instrumental = merged['is_instrumental'] === 'true' || merged['instrumental'] === 'true'
  const settled: Record<string, string> = lyrics === undefined || instrumental ? rest : { ...rest, lyrics }
  await outputDirectory(cwd)
  exec.signal.throwIfAborted()
  const request = {
    operation,
    model,
    prompt,
    ...chosen.taskType !== undefined ? { taskType: chosen.taskType } : {},
    ...chosen.references.length > 0 ? { referenceImages: chosen.references } : {},
    ...chosen.sourceVideo !== undefined ? { sourceVideo: chosen.sourceVideo } : {},
    params: settled,
  }
  const key = fingerprint(exec.agent?.session.id ?? '', cwd, request)
  let url: string
  const session = exec.agent?.session.id ?? ''
  const userTextHash = exec.agent === undefined ? undefined : userTextHashOf(exec.agent.session)
  const identity = { session, cwd, request, ...userTextHash === undefined ? {} : { userTextHash } }
  const legacyRequest = operation === 'generate_music'
    ? { ...request, params: Object.fromEntries(Object.entries(request.params).filter(([name]) => name !== 'instructions')) }
    : undefined
  const legacyKey = legacyRequest === undefined ? undefined : fingerprint(session, cwd, legacyRequest)
  const existing = await pending.find(key)
    ?? (legacyKey === undefined ? undefined : await pending.find(legacyKey))
    ?? await pending.find(key, identity)
  let taskId = existing?.taskId
  const pendingKey = existing?.key ?? key
  const settle = async (task: string): Promise<string> => await waitFor(
    ctx, what, task, operation, budgetMs, exec.signal,
    async () => { await pending.forget(pendingKey) },
  )
  if (taskId === undefined) {
    const submitted = await ctx.suanliMedia.submit(request)
    if (!submitted.ok) throw failure(what, submitted.reason, submitted.detail)
    taskId = submitted.taskId
    if (submitted.url === undefined) await pending.remember(key, taskId, identity)
    url = submitted.url ?? await settle(taskId)
  } else {
    url = await settle(taskId)
  }
  exec.signal.throwIfAborted()
  const { path, data } = await saveArtifact(ctx, what, url, cwd, bytes => typeOf(bytes, role).extension)
  await pending.forget(pendingKey)
  try {
    await pending.rememberArtifact(cwd, path, taskId, data)
  } catch (error) {
    ctx.logger.warn('suanli media tools: recording artifact task %s failed: %s', taskId, String(error))
  }
  const mediaType = typeOf(data, role).mediaType
  const reviewed = role === 'video' ? await review(ctx, prompt, [{ url, mediaType }]) : undefined
  return {
    ...base,
    status: 'generated',
    parameters: Object.entries(settled).filter(([key]) => key !== 'lyrics').map(([key, value]) => ({ key, value })),
    media: [{ path, mediaType }],
    ...reviewed !== undefined ? { review: reviewed } : {},
  }
}

/**
 * Settle with a poll, or reject as soon as the call stops so shutdown never waits out the poll.
 * @param poll - one status poll.
 * @param signal - call cancellation.
 * @returns the poll result.
 */
async function untilAborted<T>(poll: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('The call stopped.')) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([poll, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Whether the call stopped because the Host is shutting down rather than because the user stopped it.
 * @param signal - aborted call signal.
 * @returns true for a Host shutdown, which leaves the task rendering and resumable.
 */
function shutdown(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason
  return typeof reason === 'object' && reason !== null && (reason as { kind?: unknown }).kind === 'disposed'
}

/**
 * Poll one task until it delivers; a stop cancels the task at the gateway.
 * @param ctx - plugin context.
 * @param what - which generation, for errors.
 * @param taskId - gateway task id.
 * @param operation - operation that submitted it.
 * @param budgetMs - longest the call waits.
 * @param signal - call cancellation.
 * @param settled - called once the task can no longer deliver: it failed, was cancelled, or the call stopped it.
 * @returns the artifact URL.
 * @throws When the task failed, was cancelled, or outlasted the budget; an outlasted task stays resumable.
 */
async function waitFor(
  ctx: Context, what: string, taskId: string, operation: MediaOperation, budgetMs: number, signal: AbortSignal,
  settled: () => Promise<void>,
): Promise<string> {
  const cancel = (): void => {
    if (shutdown(signal)) return
    void settled().catch(() => {})
    void ctx.suanliMedia.cancel(taskId, operation).catch((error: unknown) => {
      ctx.logger.warn('suanli media tools: cancelling task %s failed: %s', taskId, String(error))
    })
  }
  if (signal.aborted) cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const deadline = Date.now() + budgetMs
    for (;;) {
      signal.throwIfAborted()
      const left = deadline - Date.now()
      if (left <= 0) throw failure(what, 'timed-out', undefined)
      const waited = await untilAborted(ctx.suanliMedia.wait(taskId, operation, Math.min(POLL_MS, left)), signal)
      signal.throwIfAborted()
      if (!waited.ok) {
        if (waited.reason === 'timed-out') continue
        if (GONE.has(waited.reason)) await settled()
        throw failure(what, waited.reason, waited.detail)
      }
      const { status } = waited
      if (status.url !== undefined) return status.url
      if (status.state !== 'running') await settled()
      if (status.state === 'failed') throw failure(what, 'rejected', status.error)
      if (status.state === 'cancelled') throw failure(what, 'cancelled', status.error)
      if (status.state === 'succeeded') throw failure(what, 'no-artifact', status.error)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/**
 * Pick the video model and inputs: reference images use a reference mode, frames a frame mode,
 * and nothing a text mode; the role's choice wins when it offers that mode.
 * @param ctx - plugin context.
 * @param entries - video entries of the catalog.
 * @param preferred - the role's model.
 * @param cwd - session workspace.
 * @param args - model arguments.
 * @param signal - call cancellation.
 * @returns the plan.
 * @throws When the inputs conflict, no model offers the mode, or the inputs exceed it.
 */
async function planVideo(
  ctx: Context, pending: PendingTasks, entries: readonly CapabilityEntry[], preferred: string | null, cwd: string,
  args: VideoArgs, signal: AbortSignal,
): Promise<Plan> {
  {
    const references = args.reference_images ?? []
    const frames = [args.first_frame, args.last_frame].filter((path): path is string => path !== undefined && path !== '')
    const source = args.source_video === undefined || args.source_video === '' ? undefined : args.source_video
    if (references.length > 0 && frames.length > 0) throw new Error('Pass either frames or reference images, not both.')
    if (source !== undefined && references.length + frames.length > 0) throw new Error('A continued clip takes no images.')
    if (args.first_frame === undefined && args.last_frame !== undefined) throw new Error('last_frame needs first_frame.')
    const wanted = source !== undefined ? 'video-extension'
      : references.length > 0 ? 'reference' : frames.length > 0 ? 'first-last-frame' : 'text-to-video'
    const offers = (entry: CapabilityEntry): CapabilityMode | undefined | null =>
      entry.modes === undefined || entry.modes.length === 0 ? null : entry.modes.find(mode => mode.id === wanted)
    const entry = entries.find(item => item.model === preferred && offers(item) !== undefined)
      ?? entries.find(item => offers(item) !== undefined)
    if (entry === undefined) throw new Error(`No video model in the gateway catalog offers ${wanted}.`)
    const mode = offers(entry) ?? undefined
    const images = references.length > 0 ? references : frames
    const most = mode?.references.image.max ?? entry.limits.maxReferenceImages
    if (images.length > most) {
      throw new Error(most === 0
        ? `${modeName(wanted)} takes no images.`
        : `${modeName(wanted)} takes at most ${String(most)} images.`)
    }
    const taskType = mode === undefined ? undefined
      : images.length === 1 && mode.taskTypeIfSingleImage !== undefined ? mode.taskTypeIfSingleImage : mode.taskType
    const hasMode = entry.paramSchema?.properties['image_mode'] !== undefined
    return {
      entry: wanted === 'video-extension' ? only768(entry) : entry,
      modelLabel: labelOf(ctx, 'video', entry),
      ...taskType !== undefined ? { taskType } : {},
      references: await readImages(ctx, images, cwd, signal),
      ...source !== undefined ? { sourceVideo: await readVideo(ctx, pending, source, cwd, signal) } : {},
      extra: hasMode && mode !== undefined ? { image_mode: mode.id } : {},
    }
  }
}

/**
 * Narrow the resolution choices of a continuation to the 768P the gateway accepts.
 * @param entry - the continuation model.
 * @returns the entry with only 768P resolutions offered.
 * @throws When the model offers no 768P resolution.
 */
function only768(entry: CapabilityEntry): CapabilityEntry {
  const schema = entry.paramSchema
  if (schema === undefined) return entry
  const properties = { ...schema.properties }
  for (const key of RESOLUTION.keys) {
    const property = properties[key]
    if (property?.enum === undefined) continue
    const values = property.enum.filter(value => value.toUpperCase().includes('768'))
    if (values.length === 0) throw new Error('A continued clip is 768P only, and this model offers no 768P.')
    properties[key] = {
      ...property,
      enum: values,
      ...property.default !== undefined && !values.includes(property.default) ? { default: values[0] } : {},
    }
  }
  return { ...entry, paramSchema: { ...schema, properties } }
}

/**
 * Pick the music model; lyrics go along only when the piece has vocals and the model takes them.
 * @param ctx - plugin context.
 * @param entries - music entries of the catalog.
 * @param preferred - the role's model.
 * @param args - model arguments.
 * @returns the plan.
 */
function planMusic(ctx: Context, entries: readonly CapabilityEntry[], preferred: string | null, args: MusicArgs): Plan {
  const entry = entries.find(item => item.model === preferred) ?? entries[0]
  if (entry === undefined) throw new Error('No music model is available in the gateway catalog.')
  const lyrics = args.lyrics?.trim() ?? ''
  const takesLyrics = entry.paramSchema?.properties['lyrics'] !== undefined
  return {
    entry,
    modelLabel: labelOf(ctx, 'music', entry),
    references: [],
    extra: {
      instructions: args.prompt,
      ...lyrics !== '' && takesLyrics && args.instrumental !== true ? { lyrics } : {},
    },
  }
}

/**
 * Model name the card shows.
 * @param ctx - plugin context.
 * @param role - model role.
 * @param entry - chosen entry.
 * @returns the label.
 */
function labelOf(ctx: Context, role: 'video' | 'music', entry: CapabilityEntry): string {
  const state = ctx.suanliModels.roles().find(item => item.role === role)
  return state?.candidates.find(candidate => candidate.model === entry.model)?.label ?? entry.displayName.zh
}

/**
 * Model-readable name of one video mode.
 * @param mode - mode id.
 * @returns the name.
 */
function modeName(mode: string): string {
  return mode === 'reference' ? 'Reference-to-video'
    : mode === 'first-last-frame' ? 'Frame-to-video'
      : mode === 'video-extension' ? 'Video continuation' : 'Text-to-video'
}

/**
 * Read the clip to continue through the session's filesystem policy.
 * @param ctx - plugin context.
 * @param path - workspace path.
 * @param cwd - session workspace.
 * @param signal - call cancellation.
 * @returns its gateway task reference when this tool produced it, otherwise its data URL.
 * @throws When the file is not an MP4 or WebM clip.
 */
async function readVideo(ctx: Context, pending: PendingTasks, path: string, cwd: string, signal: AbortSignal): Promise<string> {
  const target = await ctx.fs.resolve(path, { cwd, signal })
  const data = await ctx.fs.readBytes(target, signal, MAX_SOURCE_VIDEO_BYTES)
  const taskId = await pending.findArtifact(cwd, target.displayPath, data)
  if (taskId !== undefined) return `task:${taskId}`
  const isMp4 = ascii(data, 4, 4) === 'ftyp'
  if (!isMp4 && !(data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3)) {
    throw new Error(`"${path}" is not an MP4 or WebM clip.`)
  }
  return `data:${isMp4 ? 'video/mp4' : 'video/webm'};base64,${Buffer.from(data).toString('base64')}`
}

/**
 * Read frames or reference images through the session's filesystem policy.
 * @param ctx - plugin context.
 * @param paths - workspace paths.
 * @param cwd - session workspace.
 * @param signal - call cancellation.
 * @returns data URLs in call order.
 * @throws When a file is not an image.
 */
async function readImages(ctx: Context, paths: readonly string[], cwd: string, signal: AbortSignal): Promise<string[]> {
  const urls: string[] = []
  for (const path of paths) {
    const target = await ctx.fs.resolve(path, { cwd, signal })
    const data = await ctx.fs.readBytes(target, signal, MAX_REFERENCE_BYTES)
    const mediaType = imageTypeOf(data)
    if (mediaType === undefined) throw new Error(`"${path}" is not a PNG, JPEG, or WebP image.`)
    urls.push(`data:${mediaType};base64,${Buffer.from(data).toString('base64')}`)
  }
  return urls
}

/**
 * Image type from its leading bytes.
 * @param data - file bytes.
 * @returns the type, or `undefined` for anything else.
 */
function imageTypeOf(data: Uint8Array): string | undefined {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') return 'image/webp'
  return undefined
}

/**
 * Type and extension of a generated file from its leading bytes.
 * @param data - file bytes.
 * @param role - what was generated, for the fallback.
 * @returns the type and extension.
 */
export function typeOf(data: Uint8Array, role: 'video' | 'music'): { mediaType: string; extension: string } {
  if (ascii(data, 4, 4) === 'ftyp') {
    return role === 'music' ? { mediaType: 'audio/mp4', extension: '.m4a' } : { mediaType: 'video/mp4', extension: '.mp4' }
  }
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) {
    return role === 'music' ? { mediaType: 'audio/webm', extension: '.webm' } : { mediaType: 'video/webm', extension: '.webm' }
  }
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WAVE') return { mediaType: 'audio/wav', extension: '.wav' }
  if (ascii(data, 0, 4) === 'fLaC') return { mediaType: 'audio/flac', extension: '.flac' }
  if (ascii(data, 0, 4) === 'OggS') return { mediaType: 'audio/ogg', extension: '.ogg' }
  if (ascii(data, 0, 3) === 'ID3' || (data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0)) {
    return { mediaType: 'audio/mpeg', extension: '.mp3' }
  }
  return role === 'music' ? { mediaType: 'audio/mpeg', extension: '.mp3' } : { mediaType: 'video/mp4', extension: '.mp4' }
}

/**
 * ASCII text at one byte range.
 * @param data - file bytes.
 * @param offset - first byte.
 * @param length - byte count.
 * @returns the text.
 */
function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length))
}
