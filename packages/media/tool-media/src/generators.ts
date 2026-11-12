/**
 * The real media generators the node runner calls: image, video, speech, and music through the
 * product gateway, plus the frame extraction a tail chain needs.
 * @module
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { MediaCatalog } from './catalog.ts'
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
      const plan = planVideo(await catalogOf(gateway), {
        prompt: call.prompt,
        references,
        ...call.firstFramePath === undefined ? {} : { firstFrame: await reference(call.firstFramePath) },
        ...call.lastFramePath === undefined ? {} : { lastFrame: await reference(call.lastFramePath) },
        ...call.entry.seconds === undefined ? {} : { duration: String(call.entry.seconds) },
      }, call.entry.model, deps.videoDefaultDuration)
      if (plan.kind !== 'ready') throw new Error(plan.kind === 'ask' ? 'the gateway needs a parameter choice before video generation' : plan.reason)
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
