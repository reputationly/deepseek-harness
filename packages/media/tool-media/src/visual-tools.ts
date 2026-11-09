/**
 * Image and video tools whose models and parameter values come from the key's capability catalog.
 * A parameter the user left open, or stated outside the catalog, is handed back as a choice instead
 * of being guessed.
 * @module
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CatalogSource, MediaCatalog } from './catalog.ts'
import type { ParamChoice } from './choices.ts'
import { awaitTask, downloadMedia, editImages, generateImage, submitTask, type GatewayRequest } from './gateway.ts'
import { planImage, planVideo, type ReferenceImage } from './planner.ts'

/** What the visual tools need from the plugin. */
export interface VisualToolDeps {
  readonly request: (signal: AbortSignal) => Promise<GatewayRequest>
  readonly catalog: CatalogSource | undefined
  readonly imageModel: string
  readonly videoModel: string
  readonly videoDefaultDuration: number
  readonly taskTimeoutMs: number
  readonly pollIntervalMs: number
  readonly write: (prefix: string, contentType: string, bytes: Uint8Array) => Promise<string>
}

/** Tool result: a written file, or the choices the user must make before generation. */
interface VisualResult {
  status: 'done' | 'needs_choice'
  model: string
  path?: string
  choices?: ParamChoice[]
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}

async function reference(path: string): Promise<ReferenceImage> {
  const bytes = await readFile(path)
  const type = IMAGE_TYPES[extname(path).toLowerCase()] ?? 'image/png'
  return { dataURI: `data:${type};base64,${bytes.toString('base64')}`, bytes: bytes.byteLength }
}

async function catalogOf(deps: VisualToolDeps, gateway: GatewayRequest): Promise<MediaCatalog | undefined> {
  if (deps.catalog === undefined) return undefined
  try {
    return await deps.catalog.load(gateway.apiKey, gateway.signal)
  } catch (error: unknown) {
    if (gateway.signal.aborted) throw error
    // A gateway without a capability catalog keeps the configured models and passes values through.
    return undefined
  }
}

const STATED = 'Pass a value only when the user stated it in this conversation; never fill one in yourself.'

const resultSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    status: { type: 'string' as const, required: true as const, enum: ['done', 'needs_choice'] as const },
    model: { type: 'string' as const, required: true as const },
    path: { type: 'string' as const },
    choices: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          id: { type: 'string' as const, required: true as const },
          title: { type: 'string' as const, required: true as const },
          options: { type: 'array' as const, required: true as const, items: { type: 'string' as const } },
          recommended: { type: 'string' as const, required: true as const },
          rejected: { type: 'string' as const },
        },
      },
    },
  },
}

function plainChoice(choice: ParamChoice) {
  return {
    id: choice.id, title: choice.title, options: [...choice.options], recommended: choice.recommended,
    ...choice.rejected === undefined ? {} : { rejected: choice.rejected },
  }
}

function renderResult(tool: string, value: VisualResult) {
  if (value.status === 'done') return [{ type: 'text' as const, text: `Wrote ${value.path ?? ''}.` }]
  const lines = (value.choices ?? []).map((choice) => {
    const rejected = choice.rejected === undefined ? '' : ` The user asked for "${choice.rejected}", which is not supported.`
    return `- ${choice.id} (${choice.title}): options ${choice.options.join(', ')}; recommended ${choice.recommended}.${rejected}`
  })
  return [{
    type: 'text' as const,
    text: [
      'Nothing was generated yet. Ask the user with ask_user_question, one question per parameter below.',
      'Put the recommended option first and mark it "(推荐)". When a requested value is unsupported, say so in the question and list what is supported.',
      `Then call ${tool} again with the user's answers and the same other arguments.`,
      ...lines,
    ].join('\n'),
  }]
}

/**
 * Register generate_image and generate_video.
 * @param ctx - context whose tools registry receives the registrations.
 * @param deps - gateway access, catalog, and output settings.
 */
export function registerVisualTools(ctx: Context, deps: VisualToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate an image from a text prompt, or edit and combine local reference images. '
      + 'When the result has status needs_choice nothing was generated: ask the user the listed questions, then call again.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the image should show, or how to change the references.' },
      referenceImages: { type: 'array', items: { type: 'string' }, description: 'Local image files to edit or combine. Omit to generate from the prompt alone.' },
      aspectRatio: { type: 'string', description: `Aspect ratio such as 16:9, 9:16, 1:1, or adaptive. ${STATED}` },
      resolution: { type: 'string', description: `Resolution tier such as 1K or 2K. ${STATED}` },
    },
    output: { schema: resultSchema, render: (_args, value) => renderResult('generate_image', value as unknown as VisualResult) },
    async execute(args, exec) {
      const input = args
      const gateway = await deps.request(exec.signal)
      const references = await Promise.all((input.referenceImages ?? []).map(reference))
      const plan = planImage(await catalogOf(deps, gateway), {
        prompt: input.prompt, references,
        ...input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio },
        ...input.resolution === undefined ? {} : { resolution: input.resolution },
      }, deps.imageModel)
      if (plan.kind === 'reject') throw new Error(`generate_image: ${plan.reason}`)
      if (plan.kind === 'ask') return { status: 'needs_choice' as const, model: plan.model, choices: plan.choices.map(plainChoice) }
      const url = plan.call.endpoint === 'edits'
        ? await editImages(gateway, { model: plan.model, prompt: input.prompt, images: plan.call.images })
        : await generateImage(gateway, {
          model: plan.model, prompt: input.prompt, ...plan.call.size === undefined ? {} : { size: plan.call.size },
        })
      const media = await downloadMedia(gateway, url)
      return { status: 'done' as const, model: plan.model, path: await deps.write('image', media.contentType, media.bytes) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'generate_video',
    description: 'Generate a short video from a text prompt, from a first frame (and optional last frame), or from reference images. '
      + 'When the result has status needs_choice nothing was generated: ask the user the listed questions, then call again.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What happens in the video: subject, motion, camera, and style.' },
      aspectRatio: { type: 'string', description: `Aspect ratio such as 16:9, 9:16, 1:1, or adaptive. Ignored with frames. ${STATED}` },
      resolution: { type: 'string', description: `Resolution tier such as 768P or 2K. ${STATED}` },
      duration: { type: 'string', description: `Length in seconds, such as 5. ${STATED}` },
      audio: { type: 'boolean', description: `Whether the video has sound. ${STATED}` },
      firstFrame: { type: 'string', description: 'Local image file used as the first frame.' },
      lastFrame: { type: 'string', description: 'Local image file used as the last frame; needs firstFrame.' },
      referenceImages: { type: 'array', items: { type: 'string' }, description: 'Local image files whose subject or product the video keeps consistent; not combined with frames.' },
    },
    output: { schema: resultSchema, render: (_args, value) => renderResult('generate_video', value as unknown as VisualResult) },
    async execute(args, exec) {
      const input = args
      const gateway = await deps.request(exec.signal)
      const plan = planVideo(await catalogOf(deps, gateway), {
        prompt: input.prompt,
        references: await Promise.all((input.referenceImages ?? []).map(reference)),
        ...input.firstFrame === undefined ? {} : { firstFrame: await reference(input.firstFrame) },
        ...input.lastFrame === undefined ? {} : { lastFrame: await reference(input.lastFrame) },
        ...input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio },
        ...input.resolution === undefined ? {} : { resolution: input.resolution },
        ...input.duration === undefined ? {} : { duration: input.duration },
        ...input.audio === undefined ? {} : { audio: input.audio },
      }, deps.videoModel, deps.videoDefaultDuration)
      if (plan.kind === 'reject') throw new Error(`generate_video: ${plan.reason}`)
      if (plan.kind === 'ask') return { status: 'needs_choice' as const, model: plan.model, choices: plan.choices.map(plainChoice) }
      const id = await submitTask(gateway, plan.model, { ...plan.body })
      const url = await awaitTask(gateway, id, { timeoutMs: deps.taskTimeoutMs, intervalMs: deps.pollIntervalMs })
      const media = await downloadMedia(gateway, url)
      return { status: 'done' as const, model: plan.model, path: await deps.write('video', media.contentType, media.bytes) }
    },
  }))
}
