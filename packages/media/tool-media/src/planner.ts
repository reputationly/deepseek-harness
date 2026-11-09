/**
 * Turn one image or video request into a gateway call, or into the choices the user must make
 * first, from the capability catalog the key sees.
 * @module
 */

import { capabilitiesFor, type Capability, type MediaCatalog } from './catalog.ts'
import { settleParams, type ParamChoice } from './choices.ts'

/** One local reference image, already encoded for the gateway. */
export interface ReferenceImage {
  readonly dataURI: string
  readonly bytes: number
}

/** A request the user still has to settle. */
export interface AskPlan {
  readonly kind: 'ask'
  readonly model: string
  readonly choices: readonly ParamChoice[]
}

/** A request that cannot be served under the key's catalog. */
export interface RejectPlan {
  readonly kind: 'reject'
  readonly reason: string
}

/** Settled image call. */
export type ImagePlan = AskPlan | RejectPlan | {
  readonly kind: 'ready'
  readonly model: string
  readonly call: { readonly endpoint: 'generations'; readonly size?: string } | { readonly endpoint: 'edits'; readonly images: readonly string[] }
}

/** Settled video task. */
export type VideoPlan = AskPlan | RejectPlan | {
  readonly kind: 'ready'
  readonly model: string
  readonly body: Readonly<Record<string, unknown>>
}

/** Stated image parameters. */
export interface ImageInput {
  readonly prompt: string
  readonly aspectRatio?: string
  readonly resolution?: string
  readonly references: readonly ReferenceImage[]
}

/** Stated video parameters. */
export interface VideoInput {
  readonly prompt: string
  readonly aspectRatio?: string
  readonly resolution?: string
  readonly duration?: string
  readonly audio?: boolean
  readonly firstFrame?: ReferenceImage
  readonly lastFrame?: ReferenceImage
  readonly references: readonly ReferenceImage[]
}

const ADAPTIVE = 'adaptive'

function limitCheck(capability: Capability, images: readonly ReferenceImage[]): string | undefined {
  const maxCount = capability.limits?.maxReferenceImages ?? 0
  if (maxCount > 0 && images.length > maxCount) {
    return `${capability.model} accepts at most ${String(maxCount)} reference images; ${String(images.length)} were given`
  }
  const maxBytes = capability.limits?.maxInputBytes ?? 0
  const oversized = maxBytes > 0 ? images.find(image => image.bytes > maxBytes) : undefined
  if (oversized !== undefined) return `${capability.model} accepts images up to ${String(Math.floor(maxBytes / 1_048_576))} MB each`
  return undefined
}

/**
 * Pixel size for an aspect ratio at a resolution tier: the short edge follows the tier and the long
 * edge the ratio, both rounded to a multiple of 8.
 * @param aspectRatio - `w:h`.
 * @param resolution - `1K` or `2K`.
 * @returns `WIDTHxHEIGHT`, or undefined for an adaptive or unparsable ratio.
 */
export function imagePixelSize(aspectRatio: string, resolution: string): string | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/u.exec(aspectRatio.trim())
  if (match === null) return undefined
  const ratio = Number(match[1]) / Number(match[2])
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined
  const shortEdge = resolution.trim().toUpperCase() === '2K' ? 1440 : 1024
  const round8 = (value: number) => Math.max(8, Math.round(value / 8) * 8)
  const [width, height] = ratio >= 1 ? [shortEdge * ratio, shortEdge] : [shortEdge, shortEdge / ratio]
  return `${String(round8(width))}x${String(round8(height))}`
}

/**
 * Plan one image request.
 * @param catalog - catalog the key sees; undefined when the gateway publishes none.
 * @param input - what the caller stated.
 * @param fallbackModel - configured model used without a catalog.
 * @returns the gateway call, the choices to make first, or why it cannot run.
 */
export function planImage(catalog: MediaCatalog | undefined, input: ImageInput, fallbackModel: string): ImagePlan {
  const editing = input.references.length > 0
  if (catalog === undefined) {
    return editing
      ? { kind: 'ready', model: fallbackModel, call: { endpoint: 'edits', images: input.references.map(image => image.dataURI) } }
      : { kind: 'ready', model: fallbackModel, call: { endpoint: 'generations' } }
  }
  const candidates = capabilitiesFor(catalog, 'generate_image')
  const capability = editing
    ? candidates.find(candidate => (candidate.limits?.maxReferenceImages ?? 0) > 0 && (candidate.taskTypes === undefined || candidate.taskTypes.includes('i2i')))
    : candidates.find(candidate => candidate.taskTypes === undefined || candidate.taskTypes.length === 0 || candidate.taskTypes.includes('t2i')) ?? candidates[0]
  if (capability === undefined) {
    return { kind: 'reject', reason: editing ? 'no image model available to this key accepts reference images' : 'no image model is available to this key' }
  }
  const overLimit = limitCheck(capability, input.references)
  if (overLimit !== undefined) return { kind: 'reject', reason: overLimit }
  // A reference image fixes the canvas, so only a text-to-image request chooses one.
  const settled = settleParams(capability, {
    requested: { aspect_ratio: input.aspectRatio, resolution: input.resolution },
    ask: editing ? [] : ['aspect_ratio', 'resolution'],
    skip: editing ? ['aspect_ratio', 'resolution'] : [],
  })
  if (settled.kind === 'ask') return { kind: 'ask', model: capability.model, choices: settled.choices }
  if (editing) return { kind: 'ready', model: capability.model, call: { endpoint: 'edits', images: input.references.map(image => image.dataURI) } }
  const ratio = settled.params.aspect_ratio ?? ADAPTIVE
  const size = ratio.toLowerCase() === ADAPTIVE ? undefined : imagePixelSize(ratio, settled.params.resolution ?? '')
  return { kind: 'ready', model: capability.model, call: { endpoint: 'generations', ...size === undefined ? {} : { size } } }
}

function acceptsReferences(capability: Capability): boolean {
  return capability.taskTypes?.includes('r2va') === true
    || capability.paramSchema?.properties?.image_mode?.enum?.includes('reference') === true
}

/**
 * Plan one video task.
 * @param catalog - catalog the key sees; undefined when the gateway publishes none.
 * @param input - what the caller stated.
 * @param fallbackModel - configured model used without a catalog.
 * @param defaultDuration - product default length in seconds, recommended over the gateway's.
 * @returns the task body, the choices to make first, or why it cannot run.
 */
export function planVideo(catalog: MediaCatalog | undefined, input: VideoInput, fallbackModel: string, defaultDuration: number): VideoPlan {
  const frames = [input.firstFrame, input.lastFrame].filter((frame): frame is ReferenceImage => frame !== undefined)
  const referenced = input.references.length > 0
  if (referenced && frames.length > 0) return { kind: 'reject', reason: 'use either first/last frames or reference images, not both' }
  if (input.lastFrame !== undefined && input.firstFrame === undefined) return { kind: 'reject', reason: 'a last frame needs a first frame' }
  const taskType = referenced ? 'r2va' : frames.length === 2 ? 'flf2v' : frames.length === 1 ? 'i2v' : 't2v'
  const media: Record<string, unknown> = {}
  if (frames.length === 1) media.image = frames.map(frame => frame.dataURI)[0]
  if (frames.length === 2) media.images = frames.map(frame => frame.dataURI)

  if (catalog === undefined) {
    return {
      kind: 'ready', model: fallbackModel, body: {
        prompt: input.prompt, ...media,
        ...input.duration === undefined ? {} : { duration: Number.parseInt(input.duration, 10) },
        ...input.resolution === undefined ? {} : { size: input.resolution },
        metadata: { task_type: taskType, ...referenced ? { src_ref_images: input.references.map(image => image.dataURI) } : {} },
      },
    }
  }
  const candidates = capabilitiesFor(catalog, 'generate_video')
  const capability = referenced ? candidates.find(acceptsReferences) : candidates.find(candidate => !acceptsReferences(candidate))
  if (capability === undefined) {
    return { kind: 'reject', reason: referenced ? 'no video model available to this key accepts reference images' : 'no video model is available to this key' }
  }
  const overLimit = limitCheck(capability, referenced ? input.references : frames)
  if (overLimit !== undefined) return { kind: 'reject', reason: overLimit }
  // First and last frames fix the canvas; sending a ratio as well stretches the picture.
  const frameDriven = frames.length > 0
  const settled = settleParams(capability, {
    requested: {
      ratio: frameDriven ? undefined : input.aspectRatio,
      resolution: input.resolution,
      duration: input.duration,
      generate_audio: input.audio === undefined ? undefined : String(input.audio),
    },
    ask: frameDriven ? ['resolution', 'duration'] : ['ratio', 'resolution', 'duration'],
    defaults: { duration: String(defaultDuration) },
    skip: frameDriven ? ['ratio', 'image_mode'] : ['image_mode'],
  })
  if (settled.kind === 'ask') return { kind: 'ask', model: capability.model, choices: settled.choices }
  const { ratio, resolution, duration, generate_audio: audio } = settled.params
  const metadata: Record<string, unknown> = {
    task_type: taskType,
    ...audio === undefined ? {} : { generate_audio: audio === 'true' },
    ...resolution === undefined ? {} : { resolution },
    ...referenced ? { src_ref_images: input.references.map(image => image.dataURI) } : {},
  }
  return {
    kind: 'ready',
    model: capability.model,
    body: {
      prompt: input.prompt,
      ...media,
      ...duration === undefined ? {} : { duration: Number.parseInt(duration, 10) },
      // The tier word is the final size; a tier at or below the generation stage skips the upscale stage.
      ...resolution === undefined ? {} : { size: resolution },
      ...ratio === undefined || ratio.toLowerCase() === ADAPTIVE ? {} : { aspect_ratio: ratio },
      metadata,
    },
  }
}
