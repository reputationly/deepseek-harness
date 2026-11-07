/**
 * Model-facing media tools over the product gateway: image generation and editing, speech synthesis,
 * music, and video.
 *
 * Every tool resolves the API key from the credential store by reference, so no secret reaches a
 * model request or the session log. Asynchronous music and video calls return a task id and are
 * awaited inside the tool budget; generated files land in the configured output directory and only
 * their paths return to the model.
 * @module @deepseek-ai/dsh-tool-media
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { awaitTask, downloadMedia, editImage, generateImage, generateSpeech, submitTask, type GatewayRequest } from './gateway.ts'

export { MediaGatewayError } from './gateway.ts'
export type { MediaArtifact } from './gateway.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-media'

/** Services required by the media tools. */
export const inject = ['tools']

/** Config for one deployment's media gateway. */
export interface Config {
  /** Gateway root including its API prefix. */
  baseURL: string
  /** Credential reference resolved per call; never the key itself. */
  apiKeyEnv?: string
  /** Image model id. */
  imageModel?: string
  /** Speech model id. */
  speechModel?: string
  /** Music model id. */
  musicModel?: string
  /** Video model id. */
  videoModel?: string
  /** Directory for generated files; relative paths resolve against the process working directory. */
  outputDir?: string
  /** Budget for one asynchronous task, including polling. */
  taskTimeoutMs?: number
  /** Delay between task polls. */
  pollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default('DSH_MAAS_API_KEY'),
  imageModel: z.string().default('qwen-image-pro'),
  speechModel: z.string().default('indextts-2.5'),
  musicModel: z.string().default('minimax-music3'),
  videoModel: z.string().default('minimax-h3-fl2va'),
  outputDir: z.string().default('media-output'),
  taskTimeoutMs: z.number().default(900_000),
  pollIntervalMs: z.number().default(3_000),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Map a media content type to a file extension. */
function extensionFor(contentType: string): string {
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('jpeg')) return '.jpg'
  if (contentType.includes('webp')) return '.webp'
  if (contentType.includes('wav')) return '.wav'
  if (contentType.includes('mp3') || contentType.includes('mpeg')) return '.mp3'
  if (contentType.includes('mp4')) return '.mp4'
  return '.bin'
}

/**
 * Resolve the API key for one call.
 * @param ctx - context providing the credentials service.
 * @param ref - credential reference from config.
 * @returns the key value.
 */
async function resolveKey(ctx: Context, ref: CredentialRef): Promise<string> {
  const credentials = ctx.get('credentials')
  const hit = credentials === undefined ? undefined : await credentials.resolve(ref)
  if (hit !== undefined) return hit.value
  const ambient = launchEnvironmentOf(ctx).get(ref)?.value ?? process.env[ref]
  if (ambient === undefined || ambient === '') {
    throw new Error(`tool-media: no API key for ${ref}; store it through the credentials service or export it in the launching environment`)
  }
  return ambient
}

/** MIME type for a local reference-audio file. */
function audioMimeType(path: string): string {
  if (path.endsWith('.mp3')) return 'audio/mpeg'
  if (path.endsWith('.m4a')) return 'audio/mp4'
  if (path.endsWith('.flac')) return 'audio/flac'
  return 'audio/wav'
}

/**
 * Turn a reference voice argument into something the gateway can fetch.
 * @param voice - HTTP(S) URL, data URI, or a local audio file path.
 * @returns the argument unchanged for URLs, or a data URI for a local file.
 */
async function voiceReference(voice: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(voice)) return voice
  const bytes = await readFile(voice)
  return `data:${audioMimeType(voice)};base64,${bytes.toString('base64')}`
}

/**
 * Write one media artifact under the configured output directory.
 * @param root - configured output directory.
 * @param prefix - file-name prefix naming the producing tool.
 * @param contentType - response content type.
 * @param bytes - media bytes.
 * @returns the absolute written path.
 */
async function writeArtifact(root: string, prefix: string, contentType: string, bytes: Uint8Array): Promise<string> {
  const directory = isAbsolute(root) ? root : join(process.cwd(), root)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${prefix}-${String(Date.now())}${extensionFor(contentType)}`)
  await writeFile(path, bytes)
  return path
}

/**
 * Register the media tools.
 * @param ctx - context whose tools registry receives the registrations.
 * @param config - deployment configuration with every default applied.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const ref = credentialRef(resolved.apiKeyEnv)
  const request = async (signal: AbortSignal): Promise<GatewayRequest> => ({
    baseURL: resolved.baseURL,
    apiKey: await resolveKey(ctx, ref),
    signal,
  })

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: 'Generate an image from a text prompt, or edit an existing image file when imagePath is given.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What the image should show, or how to change it.' },
      imagePath: { type: 'string', description: 'Local image file to edit. Omit to generate from the prompt alone.' },
      size: { type: 'string', description: 'Pixel size such as 1024x1024.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Wrote ${value.path} with ${value.model}.` }],
    },
    async execute(args, exec) {
      const input = args as { prompt: string; imagePath?: string; size?: string }
      const gateway = await request(exec.signal)
      const url = input.imagePath === undefined
        ? await generateImage(gateway, {
          model: resolved.imageModel,
          prompt: input.prompt,
          ...(input.size === undefined ? {} : { size: input.size }),
        })
        : await editImage(gateway, {
          model: resolved.imageModel,
          prompt: input.prompt,
          image: (await readFile(input.imagePath)).buffer as ArrayBuffer,
          filename: basename(input.imagePath),
          mimeType: 'image/png',
        })
      const media = await downloadMedia(gateway, url)
      return { path: await writeArtifact(resolved.outputDir, 'image', media.contentType, media.bytes), model: resolved.imageModel }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'generate_speech',
    description: 'Synthesize speech from text with a reference voice sample.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to speak.' },
      voice: { type: 'string', required: true, description: 'Reference voice: an audio file path, HTTP(S) URL, or data URI. The clip must be 30 seconds or shorter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Wrote ${value.path} with ${value.model}.` }],
    },
    async execute(args, exec) {
      const input = args as { text: string; voice: string }
      const gateway = await request(exec.signal)
      const audio = await generateSpeech(gateway, {
        model: resolved.speechModel,
        text: input.text,
        voice: await voiceReference(input.voice),
      })
      return { path: await writeArtifact(resolved.outputDir, 'speech', audio.contentType, audio.bytes), model: resolved.speechModel }
    },
  }))

  const taskTool = (toolName: string, model: string, description: string) => ({
    name: toolName,
    description,
    parameters: {
      prompt: { type: 'string' as const, required: true as const, description: 'What to produce, including style, instruments, tempo, and mood for music.' },
      lyrics: { type: 'string' as const, description: 'Optional lyrics for a music request.' },
    },
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          path: { type: 'string' as const, required: true as const },
          model: { type: 'string' as const, required: true as const },
        },
      },
      render: (_args: unknown, value: { path: string; model: string }) => [{ type: 'text' as const, text: `Wrote ${value.path} with ${value.model}.` }],
    },
    async execute(args: unknown, exec: { signal: AbortSignal }) {
      const input = args as { prompt: string; lyrics?: string }
      const gateway = await request(exec.signal)
      // Music3 reads the arrangement description from request metadata and the lyrics from the prompt.
      const body: Record<string, unknown> = toolName === 'generate_music'
        ? {
          prompt: input.prompt,
          metadata: {
            instructions: input.prompt,
            ...(input.lyrics === undefined ? {} : { lyrics: input.lyrics }),
          },
        }
        : { prompt: input.prompt }
      const id = await submitTask(gateway, model, body)
      const url = await awaitTask(gateway, id, { timeoutMs: resolved.taskTimeoutMs, intervalMs: resolved.pollIntervalMs })
      const media = await downloadMedia(gateway, url)
      return { path: await writeArtifact(resolved.outputDir, toolName.replace('generate_', ''), media.contentType, media.bytes), model }
    },
  })

  ctx.tools.register(defineTool(taskTool(
    'generate_music',
    resolved.musicModel,
    'Generate a music track. The prompt must describe genre, instrumentation, tempo, and mood.',
  )))
  ctx.tools.register(defineTool(taskTool(
    'generate_video',
    resolved.videoModel,
    'Generate a short video from a text prompt.',
  )))
}

/** Supported artifact file extensions, exported for tests. */
export const MEDIA_EXTENSIONS = ['.png', '.jpg', '.webp', '.wav', '.mp3', '.mp4', '.bin'] as const

/** Whether a path stays inside one directory tree, exported for tests. */
export function staysInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** File extension of one artifact path, exported for tests. */
export function artifactExtension(path: string): string {
  return extname(path)
}
