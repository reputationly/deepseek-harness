/**
 * Chat generation tools over the Hilo catalog. `generate_image` reads the image role's model,
 * checks every parameter against that model's catalog entry, asks one question card for what
 * is missing or unsupported, submits through the gateway task service, and saves the result
 * into the session's `generated/` directory.
 *
 * @module @deepseek-ai/dsh-suanli-media-tools
 */

import { mkdir, readFile, realpath, rename } from 'node:fs/promises'
import { extname, isAbsolute, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { CapabilityEntry } from '@deepseek-ai/dsh-suanli-model-catalog/types'
import type { MediaFailureReason } from '@deepseek-ai/dsh-suanli-media-tasks/types'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-suanli-model-catalog'
import type {} from '@deepseek-ai/dsh-suanli-media-tasks'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-working-directory'
import { ASPECT, RESOLUTION, check, specOf } from './params.ts'
import { questionOf, readAnswer, type OpenParameter } from './questions.ts'
import type { GeneratedImage, ImageResultMeta } from './types.ts'

export type * from './types.ts'

/** No configuration: the catalog and the task service carry the gateway. */
export interface Config {}

export const Config: z<Config> = z.object({})

export const name = 'suanli-media-tools'
export const inject = ['tools', 'fs', 'suanliModels', 'suanliMedia', 'userQuestions', 'workingDirectory']

/** Longest wait for one image. */
const IMAGE_WAIT_MS = 180_000
/** Most images one call produces. */
const MAX_COUNT = 4
/** Largest reference image read from the workspace. */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024

const description = 'Generate images from a text description, optionally guided by reference images. '
  + 'Pass the user\'s own words for aspect ratio and resolution when they give them (for example "竖屏", "4K"); '
  + 'leave them out otherwise. The tool asks the user for anything missing or unsupported, so do not ask first.'

/** Why a submission produced nothing, in the words the model and the user read. */
const FAILURES: Readonly<Record<MediaFailureReason, string>> = {
  'no-credential': 'the user is not signed in to the gateway',
  unauthorized: 'the gateway key may not use this model',
  'not-found': 'the gateway does not know this model',
  rejected: 'the gateway rejected the request',
  unreachable: 'the gateway could not be reached',
  'timed-out': 'the image did not finish in time',
  cancelled: 'the generation was cancelled',
  'no-artifact': 'the gateway returned no image',
}

/** Extension of each image type. */
const EXTENSIONS: Readonly<Record<ImageMediaType, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
}

/** Attachment reference as the result value carries it. */
type Attachment = { [key: string]: JsonValue }

/** One saved image in the result value. */
interface Saved {
  readonly path: string
  readonly attachment?: Attachment
}

/** Arguments the model passes. */
interface ImageArgs {
  readonly prompt: string
  readonly aspect_ratio?: string | undefined
  readonly resolution?: string | undefined
  readonly reference_images?: readonly string[] | undefined
  readonly count?: number | undefined
}

/**
 * Register `generate_image` while the catalog offers an image model.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  let unregister: (() => void) | undefined
  const sync = (): void => {
    const offered = ctx.suanliModels.roles().some(state => state.role === 'image' && state.candidates.length > 0)
    if (offered && unregister === undefined) unregister = ctx.tools.register(imageTool(ctx))
    if (!offered && unregister !== undefined) {
      unregister()
      unregister = undefined
    }
  }
  sync()
  ctx.on('suanli-model-catalog/roles-updated', sync)
  ctx.on('suanli-model-catalog/media-updated', sync)
}

/**
 * Build the `generate_image` definition.
 * @param ctx - plugin context.
 * @returns the tool.
 */
function imageTool(ctx: Context) {
  return defineTool({
    name: 'generate_image',
    description,
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the image shows, in the user\'s language.' },
      aspect_ratio: { type: 'string', description: 'Aspect ratio in the user\'s words, such as "16:9" or "竖屏". Omit when the user gave none.' },
      resolution: { type: 'string', description: 'Resolution in the user\'s words, such as "2K" or "4K". Omit when the user gave none.' },
      reference_images: {
        type: 'array', items: { type: 'string' },
        description: 'Workspace paths of images the result should follow.',
      },
      count: { type: 'integer', description: `How many images, 1 to ${String(MAX_COUNT)}. Defaults to 1.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['generated', 'cancelled'] },
          prompt: { type: 'string', required: true },
          model: { type: 'string', required: true },
          modelLabel: { type: 'string', required: true },
          parameters: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: { key: { type: 'string', required: true }, value: { type: 'string', required: true } },
            },
          },
          images: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                attachment: { type: 'object', additionalProperties: true, properties: {} },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'cancelled'
          ? 'The user cancelled the generation; nothing was submitted.'
          : JSON.stringify({
            status: value.status,
            model: value.model,
            parameters: Object.fromEntries(value.parameters.map(entry => [entry.key, entry.value])),
            files: value.images.map(image => image.path),
          }),
      }],
      presentationMeta: (_args, value): JsonValue => ({
        status: value.status,
        prompt: value.prompt,
        model: value.model,
        modelLabel: value.modelLabel,
        parameters: Object.fromEntries(value.parameters.map(entry => [entry.key, entry.value])),
        images: value.images.map(image => ({
          path: image.path,
          ...image.attachment !== undefined ? { attachment: image.attachment } : {},
        })),
      } satisfies Omit<ImageResultMeta, 'images'> & { images: readonly { path: string; attachment?: Attachment }[] }),
    },
    timeoutMs: IMAGE_WAIT_MS * MAX_COUNT + 600_000,
    async execute(args, exec) {
      return await generateImage(ctx, args, exec)
    },
  })
}

/**
 * Run one `generate_image` call.
 * @param ctx - plugin context.
 * @param args - model arguments.
 * @param exec - the execution.
 * @returns the canonical result.
 * @throws When no image model is offered or the gateway produced nothing.
 */
async function generateImage(ctx: Context, args: ImageArgs, exec: ToolExecution) {
  const state = ctx.suanliModels.roles().find(role => role.role === 'image')
  const model = state?.selected ?? state?.fallback ?? null
  const entry = model === null
    ? undefined
    : ctx.suanliModels.media().entries.find(item => item.operation === 'generate_image' && item.model === model)
  if (state === undefined || model === null || entry === undefined) throw new Error('No image model is available in the gateway catalog.')
  const modelLabel = state.candidates.find(candidate => candidate.model === model)?.label ?? model
  const count = Math.min(MAX_COUNT, Math.max(1, Math.floor(args.count ?? 1)))
  const cwd = await workspaceOf(ctx, exec)
  const references = await referencesOf(ctx, entry, args.reference_images ?? [], cwd, exec.signal)

  const parameters = await resolveParameters(ctx, entry, args, exec)
  const base = { prompt: args.prompt, model, modelLabel }
  if (parameters === undefined) return { ...base, status: 'cancelled' as const, parameters: [], images: [] }

  const directory = await outputDirectory(cwd)
  const images: Saved[] = []
  for (let index = 0; index < count; index++) {
    exec.signal.throwIfAborted()
    const url = await submitOne(ctx, { model, prompt: args.prompt, references, parameters })
    exec.signal.throwIfAborted()
    images.push(await saveOne(ctx, url, directory))
  }
  return {
    ...base,
    status: 'generated' as const,
    parameters: Object.entries(parameters).map(([key, value]) => ({ key, value })),
    images,
  }
}

/**
 * Settle every closed-set parameter, asking the user once for what is missing or unsupported.
 * @param ctx - plugin context.
 * @param entry - catalog entry of the chosen model.
 * @param args - model arguments.
 * @param exec - the execution.
 * @returns parameters by catalog key, or `undefined` when the user cancelled.
 * @throws When the user answered twice with values the model does not accept.
 */
async function resolveParameters(
  ctx: Context, entry: CapabilityEntry, args: ImageArgs, exec: ToolExecution,
): Promise<Record<string, string> | undefined> {
  const settled: Record<string, string> = {}
  let open: OpenParameter[] = []
  for (const [kind, requested] of [[ASPECT, args.aspect_ratio], [RESOLUTION, args.resolution]] as const) {
    const spec = specOf(entry, kind)
    if (spec === undefined) continue
    const result = check(spec, kind, requested)
    if (result.kind === 'ok') settled[spec.key] = result.value
    else open.push({ spec, kind, check: result })
  }
  for (let round = 0; open.length > 0; round++) {
    const answer = await ask(ctx, open, exec.agent, exec.signal)
    if (answer === undefined) return undefined
    const again: OpenParameter[] = []
    for (const item of open) {
      const result = readAnswer(item, answer.find(entry => entry.id === item.spec.key))
      if (result === 'skipped') return undefined
      if (result.kind === 'ok') settled[item.spec.key] = result.value
      else again.push({ ...item, check: result })
    }
    if (again.length > 0 && round > 0) {
      throw new Error(`The answers are still not supported: ${again.map(item => item.spec.label).join(', ')}.`)
    }
    open = again
  }
  return settled
}

/**
 * Raise the question card.
 * @param ctx - plugin context.
 * @param open - parameters to ask about.
 * @param agent - the calling agent.
 * @param signal - call cancellation.
 * @returns the answers, or `undefined` when the user skipped or closed the card.
 * @throws When the question service fails for another reason, including call cancellation.
 */
async function ask(ctx: Context, open: readonly OpenParameter[], agent: Agent | undefined, signal: AbortSignal) {
  try {
    const result = await ctx.userQuestions.ask({
      questions: open.map(questionOf),
      ...agent !== undefined ? { agent } : {},
      signal,
    })
    return result.answers.length === 0 ? undefined : result.answers
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === 'ASK_CANCELLED') return undefined
    throw error
  }
}

/**
 * Submit one image and wait for its URL.
 * @param ctx - plugin context.
 * @param request - what to submit.
 * @returns the artifact URL.
 * @throws When the gateway produced nothing.
 */
async function submitOne(
  ctx: Context,
  request: { model: string; prompt: string; references: readonly string[]; parameters: Readonly<Record<string, string>> },
): Promise<string> {
  const submitted = await ctx.suanliMedia.submit({
    operation: 'generate_image',
    model: request.model,
    prompt: request.prompt,
    ...request.references.length > 0 ? { referenceImages: request.references } : {},
    params: request.parameters,
  })
  if (!submitted.ok) throw failure(submitted.reason, submitted.detail)
  if (submitted.url !== undefined) return submitted.url
  const waited = await ctx.suanliMedia.wait(submitted.taskId, 'generate_image', IMAGE_WAIT_MS)
  if (!waited.ok) throw failure(waited.reason, waited.detail)
  if (waited.status.url === undefined) throw failure(waited.status.state === 'failed' ? 'rejected' : 'no-artifact', waited.status.error)
  return waited.status.url
}

/**
 * Save one artifact into `generated/` and admit it as an attachment for the card.
 * @param ctx - plugin context.
 * @param url - artifact URL.
 * @param directory - the session's generated/ directory.
 * @returns the saved image.
 * @throws When the artifact could not be written.
 */
async function saveOne(ctx: Context, url: string, directory: string): Promise<Saved> {
  const stem = join(directory, `${stamp()}-${Math.random().toString(36).slice(2, 8)}`)
  const saved = await ctx.suanliMedia.saveArtifact(url, `${stem}.png`)
  if (!saved.ok) throw failure(saved.reason, saved.detail)
  const data = new Uint8Array(await readFile(saved.path))
  const mediaType = sniff(data)
  let path = saved.path
  if (mediaType !== undefined && EXTENSIONS[mediaType] !== extname(path)) {
    path = `${stem}${EXTENSIONS[mediaType]}`
    await rename(saved.path, path)
  }
  const image: GeneratedImage = { path, ...await admit(ctx, data, mediaType, path) }
  return image.attachment === undefined ? { path } : { path, attachment: image.attachment as unknown as Attachment }
}

/**
 * Store the image where the card can load it; a refused image keeps only its file.
 * @param ctx - plugin context.
 * @param data - image bytes.
 * @param mediaType - sniffed type.
 * @param path - saved file.
 * @returns the attachment, when one was stored.
 */
async function admit(
  ctx: Context, data: Uint8Array, mediaType: ImageMediaType | undefined, path: string,
): Promise<{ attachment?: ImageAttachmentRef }> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined || mediaType === undefined) return {}
  try {
    return { attachment: await attachments.saveImage({ data, mediaType, name: path.slice(path.lastIndexOf('/') + 1) }) }
  } catch (error) {
    ctx.logger.warn('suanli media tools: the card cannot show %s: %s', path, String(error))
    return {}
  }
}

/**
 * Create the session's `generated/` directory before any image is requested.
 * @param cwd - session workspace.
 * @returns the directory path.
 * @throws When `generated/` resolves outside the workspace.
 */
async function outputDirectory(cwd: string): Promise<string> {
  const directory = join(cwd, 'generated')
  await mkdir(directory, { recursive: true })
  const inside = relative(await realpath(cwd), await realpath(directory))
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error('The workspace generated/ directory points outside the workspace.')
  }
  return directory
}

/**
 * Read the reference images the call names through the session's filesystem policy.
 * @param ctx - plugin context.
 * @param entry - catalog entry of the chosen model.
 * @param paths - workspace paths.
 * @param cwd - session workspace.
 * @param signal - call cancellation.
 * @returns data URLs in call order.
 * @throws When the model takes fewer references, or a file is not an image.
 */
async function referencesOf(
  ctx: Context, entry: CapabilityEntry, paths: readonly string[], cwd: string, signal: AbortSignal,
): Promise<string[]> {
  if (paths.length === 0) return []
  const most = entry.limits.maxReferenceImages
  if (paths.length > most) {
    throw new Error(most === 0
      ? 'The image model does not accept reference images.'
      : `The image model accepts at most ${String(most)} reference images.`)
  }
  const urls: string[] = []
  for (const path of paths) {
    const target = await ctx.fs.resolve(path, { cwd, signal })
    const data = await ctx.fs.readBytes(target, signal, MAX_REFERENCE_BYTES)
    const mediaType = sniff(data)
    if (mediaType === undefined) throw new Error(`"${path}" is not a PNG, JPEG, WebP, or GIF image.`)
    urls.push(`data:${mediaType};base64,${Buffer.from(data).toString('base64')}`)
  }
  return urls
}

/**
 * Session workspace of the call.
 * @param ctx - plugin context.
 * @param exec - the execution.
 * @returns the absolute directory; a call outside a session uses the process directory.
 */
async function workspaceOf(ctx: Context, exec: ToolExecution): Promise<string> {
  if (exec.agent === undefined) return process.cwd()
  return await ctx.workingDirectory.ensure(exec.agent, exec.signal)
}

/**
 * Error the model and the card read.
 * @param reason - task service reason.
 * @param detail - gateway wording.
 * @returns the error.
 */
function failure(reason: MediaFailureReason, detail: string | undefined): Error {
  return new Error(`Image generation failed: ${FAILURES[reason]}${detail !== undefined && detail !== '' ? ` (${detail})` : ''}.`)
}

/**
 * Sortable local time for a file name.
 * @returns `YYYYMMDD-HHMMSS`.
 */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Image type from its leading bytes.
 * @param data - file bytes.
 * @returns the type, or `undefined` for anything else.
 */
function sniff(data: Uint8Array): ImageMediaType | undefined {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}
