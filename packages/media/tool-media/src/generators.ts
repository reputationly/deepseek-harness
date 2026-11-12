/**
 * The real media generators the node runner calls: image, video, speech, and music through the
 * product gateway, plus the frame extraction a tail chain needs.
 * @module
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { capabilitiesFor, type MediaCatalog } from './catalog.ts'
import { awaitTask, downloadMedia, editImages, generateImage, generateSpeech, submitTask, type GatewayRequest } from './gateway.ts'
import { planVideo } from './planner.ts'
import type { MediaCall, MediaGenerator } from './runner.ts'

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}

/** One reference image as the gateway accepts it. */
interface Reference {
  readonly dataURI: string
  readonly bytes: number
}

/** Everything a generator needs from its deployment. */
export interface GeneratorDeps {
  /** Gateway endpoint and credential for one call. */
  readonly request: (signal: AbortSignal) => Promise<GatewayRequest>
  /** Capability catalog, when the deployment has one. */
  readonly catalog?: () => Promise<MediaCatalog | undefined>
  /** Write downloaded bytes and return the absolute path. */
  readonly write: (prefix: string, contentType: string, bytes: Uint8Array) => Promise<string>
  /** Total time one asynchronous gateway task may take. */
  readonly taskTimeoutMs: number
  /** Polling interval while an asynchronous task runs. */
  readonly pollIntervalMs: number
  /** Video duration used when a node states none. */
  readonly videoDefaultDuration: number
}

/** Read one image file as a reference. */
async function reference(path: string): Promise<Reference> {
  const bytes = await readFile(path)
  const type = IMAGE_TYPES[extname(path).toLowerCase()] ?? 'image/png'
  return { dataURI: `data:${type};base64,${bytes.toString('base64')}`, bytes: bytes.byteLength }
}

/** Height a resolution name implies, for choosing a generation tier. */
function heightOf(name: string): number | undefined {
  const normalized = name.trim().toLowerCase()
  if (/^\d+$/.test(normalized)) return Number(normalized)
  const match = /^(\d+)p$/.exec(normalized)
  if (match !== null) return Number(match[1])
  if (normalized === '2k') return 1440
  if (normalized === '4k') return 2160
  return undefined
}

/**
 * Generation tier that covers a delivery resolution.
 * @param catalog - capability catalog with the gateway's tiers.
 * @param requested - delivery resolution the project asks for.
 * @returns an offered tier, or the requested value when the catalog offers none.
 */
function generationTier(catalog: MediaCatalog | undefined, requested: string | undefined): string | undefined {
  if (catalog === undefined || requested === undefined) return requested
  const tiers = capabilitiesFor(catalog, 'generate_video')
    .flatMap(capability => capability.paramSchema?.properties?.resolution?.enum ?? [])
  const wanted = heightOf(requested)
  if (wanted === undefined || tiers.includes(requested)) return requested
  const ranked = tiers
    .map(tier => ({ tier, height: heightOf(tier) }))
    .filter((entry): entry is { tier: string; height: number } => entry.height !== undefined)
    .sort((left, right) => left.height - right.height)
  return ranked.find(entry => entry.height >= wanted)?.tier ?? ranked.at(-1)?.tier ?? requested
}

/** Prompt a music request sends. */
function musicPrompt(call: MediaCall): string {
  return call.prompt === '' ? `${call.node.title}` : call.prompt
}

/** Generator implementation bound to one deployment. */
export function createGenerator(deps: GeneratorDeps): MediaGenerator {
  const catalogOf = async (gateway: GatewayRequest): Promise<MediaCatalog | undefined> => {
    if (deps.catalog === undefined) return undefined
    try {
      return await deps.catalog()
    } catch (error: unknown) {
      if (gateway.signal.aborted) throw error
      return undefined
    }
  }
  return {
    async image(call) {
      const gateway = await deps.request(call.signal)
      const references = await Promise.all(call.refs.map(reference))
      const url = references.length === 0
        ? await generateImage(gateway, { model: call.entry.model, prompt: call.prompt })
        : await editImages(gateway, { model: call.entry.model, prompt: call.prompt, images: references.map(entry => entry.dataURI) })
      const media = await downloadMedia(gateway, url)
      return { path: await deps.write('image', media.contentType, media.bytes), model: call.entry.model }
    },
    async video(call) {
      const gateway = await deps.request(call.signal)
      const references = await Promise.all(call.refs.map(reference))
      const catalog = await catalogOf(gateway)
      const plan = planVideo(catalog, {
        prompt: call.prompt,
        references,
        ...call.firstFramePath === undefined ? {} : { firstFrame: await reference(call.firstFramePath) },
        ...call.lastFramePath === undefined ? {} : { lastFrame: await reference(call.lastFramePath) },
        ...call.entry.seconds === undefined ? {} : { duration: String(call.entry.seconds) },
        ...call.aspectRatio === undefined ? {} : { aspectRatio: call.aspectRatio },
        ...generationTier(catalog, call.resolution) === undefined ? {} : { resolution: generationTier(catalog, call.resolution) as string },
      }, call.entry.model, deps.videoDefaultDuration)
      if (plan.kind === 'ask') {
        throw new Error(`video generation needs a choice: ${plan.choices.map(choice => `${choice.id} (${choice.options.join(' / ')}, recommended ${choice.recommended})`).join('; ')}`)
      }
      if (plan.kind === 'reject') throw new Error(plan.reason)
      const id = await submitTask(gateway, plan.model, plan.body)
      const url = await awaitTask(gateway, id, { timeoutMs: deps.taskTimeoutMs, intervalMs: deps.pollIntervalMs })
      const media = await downloadMedia(gateway, url)
      return { path: await deps.write('video', media.contentType, media.bytes), model: plan.model }
    },
    async speech(call) {
      const gateway = await deps.request(call.signal)
      const voice = call.node.gen?.params.voice
      if (typeof voice !== 'string' || voice === '') {
        throw new Error(`node ${call.node.id} needs a voice before it can speak`)
      }
      const audio = await generateSpeech(gateway, { model: call.entry.model, text: call.prompt, voice })
      return { path: await deps.write('speech', audio.contentType, audio.bytes), model: call.entry.model }
    },
    async music(call) {
      const gateway = await deps.request(call.signal)
      const id = await submitTask(gateway, call.entry.model, { prompt: musicPrompt(call) })
      const url = await awaitTask(gateway, id, { timeoutMs: deps.taskTimeoutMs, intervalMs: deps.pollIntervalMs })
      const media = await downloadMedia(gateway, url)
      return { path: await deps.write('music', media.contentType, media.bytes), model: call.entry.model }
    },
  }
}
