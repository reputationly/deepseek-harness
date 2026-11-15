/**
 * The real media generators the node runner calls: image, video, speech, and music through the
 * product gateway, plus the frame extraction a tail chain needs.
 * @module
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { localMediaPath, voiceReference } from './local-path.ts'
import { capabilitiesFor, type MediaCatalog } from './catalog.ts'
import { awaitTask, awaitTaskResult, downloadMedia, editImages, generateImage, generateSpeech, submitTask, type GatewayRequest } from './gateway.ts'
import { resolveAudioPlan } from './audio-plan.ts'
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
  readonly write: (prefix: string, contentType: string, bytes: Uint8Array, onPath?: (path: string) => Promise<void>) => Promise<string>
  /** Total time one asynchronous gateway task may take. */
  readonly taskTimeoutMs: number
  /** Polling interval while an asynchronous task runs. */
  readonly pollIntervalMs: number
  /** Video duration used when a node states none. */
  readonly videoDefaultDuration: number
}

/** Read one image file as a reference. */
async function reference(path: string): Promise<Reference> {
  const local = localMediaPath(path)
  const bytes = await readFile(local)
  const type = IMAGE_TYPES[extname(local).toLowerCase()] ?? 'image/png'
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
export function generationTier(catalog: MediaCatalog | undefined, requested: string | undefined): string | undefined {
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
  return call.prompt === '' ? call.node.title : call.prompt
}

/**
 * Generator implementation bound to one deployment.
 * @param deps - endpoint, catalog, file writer, and task bounds.
 * @returns the four media generators the runner calls.
 */
export function createGenerator(deps: GeneratorDeps): MediaGenerator {
  const endpointOf = (gateway: GatewayRequest) => createHash('sha256').update(gateway.baseURL.replace(/\/+$/u, '')).digest('hex')
  const write = async (call: Pick<MediaCall, 'onArtifact'>, prefix: string, contentType: string, bytes: Uint8Array, model: string, params?: Readonly<Record<string, string | number | boolean>>) => {
    const onArtifact = call.onArtifact
    const extra = params === undefined ? {} : { params }
    const path = onArtifact === undefined
      ? await deps.write(prefix, contentType, bytes)
      : await deps.write(prefix, contentType, bytes, path => onArtifact({ path, model, ...extra }))
    return { path, model, ...extra }
  }
  const catalogOf = async (gateway: GatewayRequest): Promise<MediaCatalog | undefined> => {
    if (deps.catalog === undefined) return undefined
    try {
      return await deps.catalog()
    } catch (error: unknown) {
      if (gateway.signal.aborted) throw error
      return undefined
    }
  }
  const audio = async (call: MediaCall, kind: 'music' | 'speech') => {
    const gateway = await deps.request(call.signal)
    const catalog = await deps.catalog?.()
    const plan = resolveAudioPlan({
      kind, model: call.entry.model, prompt: kind === 'music' ? musicPrompt(call) : call.prompt,
      params: call.node.gen?.params ?? {}, ...catalog === undefined ? {} : { catalog },
      ...call.audioReferences === undefined ? {} : { audioReferences: call.audioReferences },
    })
    const reference = plan.reference === undefined ? undefined : await voiceReference(plan.reference.value)
    await call.onSubmitting?.({ prompt: plan.prompt, params: plan.params })
    if (plan.transport === 'audio_speech') {
      const { format, ...params } = plan.params
      const result = await generateSpeech(gateway, {
        model: plan.model, text: plan.prompt, params,
        ...typeof format !== 'string' ? {} : { format },
        ...reference === undefined ? {} : { voice: reference },
        ...plan.instructions === undefined ? {} : { instructions: plan.instructions },
      })
      return write(call, kind, result.contentType, result.bytes, plan.model, plan.params)
    }
    const id = await submitTask(gateway, plan.model, { prompt: plan.prompt, metadata: {
      ...plan.metadata, ...plan.reference === undefined ? {} : { [plan.reference.field]: reference },
    } })
    await call.onSubmitted?.({ id, model: plan.model, kind, endpoint: endpointOf(gateway) })
    const result = await awaitTaskResult(gateway, id, { timeoutMs: deps.taskTimeoutMs, intervalMs: deps.pollIntervalMs })
    const media = await downloadMedia(gateway, result.url)
    return write(call, kind, media.contentType, media.bytes, plan.model, {
      ...plan.params, ...result.scoreABC === undefined ? {} : { abc: result.scoreABC },
    })
  }
  return {
    async resume(task, signal, onArtifact) {
      const gateway = await deps.request(signal)
      if (endpointOf(gateway) !== task.endpoint) {
        throw Object.assign(new Error('Saved media task belongs to a different gateway; restore its gateway configuration before recovering it'), { retryable: false, recoveryRequired: true })
      }
      const result = await awaitTaskResult(gateway, task.id, { timeoutMs: deps.taskTimeoutMs, intervalMs: deps.pollIntervalMs })
      const media = await downloadMedia(gateway, result.url)
      return write({ ...onArtifact === undefined ? {} : { onArtifact } }, task.kind, media.contentType, media.bytes, task.model,
        result.scoreABC === undefined ? undefined : { abc: result.scoreABC })
    },
    async image(call) {
      const gateway = await deps.request(call.signal)
      const references = await Promise.all(call.refs.map(reference))
      await call.onSubmitting?.()
      const url = references.length === 0
        ? await generateImage(gateway, { model: call.entry.model, prompt: call.prompt,
          ...typeof call.node.gen?.params.size === 'string' ? { size: call.node.gen.params.size } : {},
        })
        : await editImages(gateway, { model: call.entry.model, prompt: call.prompt, images: references.map(entry => entry.dataURI) })
      const media = await downloadMedia(gateway, url)
      return write(call, 'image', media.contentType, media.bytes, call.entry.model)
    },
    async video(call) {
      const gateway = await deps.request(call.signal)
      const references = await Promise.all(call.refs.map(reference))
      const catalog = await catalogOf(gateway)
      const params = call.node.gen?.params ?? {}
      const aspectRatio = typeof params.aspectRatio === 'string' ? params.aspectRatio : call.aspectRatio
      const resolution = typeof params.resolution === 'string' ? params.resolution : generationTier(catalog, call.resolution)
      const plan = planVideo(catalog, {
        prompt: call.prompt,
        references,
        ...call.firstFramePath === undefined ? {} : { firstFrame: await reference(call.firstFramePath) },
        ...call.lastFramePath === undefined ? {} : { lastFrame: await reference(call.lastFramePath) },
        ...call.entry.seconds === undefined ? {} : { duration: String(call.entry.seconds) },
        ...aspectRatio === undefined ? {} : { aspectRatio },
        ...resolution === undefined ? {} : { resolution },
        ...typeof params.audio !== 'boolean' ? {} : { audio: params.audio },
      }, call.entry.model, deps.videoDefaultDuration)
      if (plan.kind === 'ask') {
        throw new Error(`video generation needs a choice: ${plan.choices.map(choice => `${choice.id} (${choice.options.join(' / ')}, recommended ${choice.recommended})`).join('; ')}`)
      }
      if (plan.kind === 'reject') throw new Error(plan.reason)
      await call.onSubmitting?.()
      const id = await submitTask(gateway, plan.model, plan.body)
      await call.onSubmitted?.({ id, model: plan.model, kind: 'video', endpoint: endpointOf(gateway) })
      const url = await awaitTask(gateway, id, { timeoutMs: deps.taskTimeoutMs, intervalMs: deps.pollIntervalMs })
      const media = await downloadMedia(gateway, url)
      return write(call, 'video', media.contentType, media.bytes, plan.model)
    },
    speech: call => audio(call, 'speech'),
    music: call => audio(call, 'music'),
  }
}
