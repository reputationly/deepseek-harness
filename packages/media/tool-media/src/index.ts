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

import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill'
import { CatalogSource } from './catalog.ts'
import { registerEditTools } from './edit-tools.ts'
import { FfmpegRunner } from './ffmpeg.ts'
import { awaitTask, downloadMedia, generateSpeech, submitTask, type GatewayRequest } from './gateway.ts'
import { placeMediaArtifact, registerVisualTools } from './visual-tools.ts'

export { MediaGatewayError } from './gateway.ts'
export type { MediaArtifact } from './gateway.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-media'

/** Required tool registry; the skill provider is read only when present. */
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
  /** Read models and parameter values from the gateway's capability catalog. */
  catalog?: boolean
  /** Disk mirror of the capability catalog; defaults under the Harness home. */
  catalogCacheFile?: string
  /** Video length recommended when the user names none, in seconds. */
  videoDefaultDuration?: number
  /** FFmpeg executable, or an absolute path to its bundled runtime copy. */
  ffmpegPath?: string
  /** FFprobe executable, or an absolute path to its bundled runtime copy. */
  ffprobePath?: string
  /** Timeout for one local editing operation. */
  editTimeoutMs?: number
  /** Absolute font path injected into non-ASCII drawtext filters. */
  fontFile?: string
  /** Absolute directory containing the bundled media-editing SKILL.md. */
  skillAssetRoot?: string
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
  catalog: z.boolean().default(true),
  catalogCacheFile: z.string().default(''),
  videoDefaultDuration: z.number().default(5),
  ffmpegPath: z.string().default('ffmpeg'),
  ffprobePath: z.string().default('ffprobe'),
  editTimeoutMs: z.number().default(600_000),
  fontFile: z.string().min(1),
  skillAssetRoot: z.string().min(1),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Omit<Config, 'fontFile' | 'skillAssetRoot'>> & Pick<Config, 'fontFile' | 'skillAssetRoot'>

function parseMediaEditingSkill(raw: string, path: string): { readonly description: string; readonly content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`tool-media: ${path} has no YAML frontmatter`)
  const description = /^description:\s*(.+)$/mu.exec(frontmatter[1])?.[1]?.trim().replace(/^["']|["']$/gu, '')
  if (description === undefined || description === '') throw new Error(`tool-media: ${path} has no description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

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
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  if (resolved.fontFile !== undefined && !isAbsolute(resolved.fontFile)) {
    throw new Error('tool-media fontFile must be an absolute path')
  }
  if (resolved.skillAssetRoot !== undefined && !isAbsolute(resolved.skillAssetRoot)) {
    throw new Error('tool-media skillAssetRoot must be an absolute directory')
  }
  const ref = credentialRef(resolved.apiKeyEnv)
  const request = async (signal: AbortSignal): Promise<GatewayRequest> => ({
    baseURL: resolved.baseURL,
    apiKey: await resolveKey(ctx, ref),
    signal,
  })

  const cacheFile = resolved.catalogCacheFile !== ''
    ? resolved.catalogCacheFile
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'ov-catalog.json')
  registerVisualTools(ctx, {
    request,
    catalog: resolved.catalog ? new CatalogSource({ baseURL: resolved.baseURL, cacheFile }) : undefined,
    imageModel: resolved.imageModel,
    videoModel: resolved.videoModel,
    videoDefaultDuration: resolved.videoDefaultDuration,
    taskTimeoutMs: resolved.taskTimeoutMs,
    pollIntervalMs: resolved.pollIntervalMs,
    write: (prefix, contentType, bytes) => writeArtifact(resolved.outputDir, prefix, contentType, bytes),
    canvas: () => ctx.get('canvas'),
  })
  let outputSequence = 0
  const ffmpeg = new FfmpegRunner(resolved.ffmpegPath, resolved.ffprobePath, resolved.editTimeoutMs)
  ctx.effect(() => () =>{  ffmpeg.dispose() }, 'tool-media: ffmpeg processes')
  registerEditTools(ctx, {
    runner: ffmpeg,
    editTimeoutMs: resolved.editTimeoutMs,
    ...(resolved.fontFile === undefined ? {} : { fontFile: resolved.fontFile }),
    writePath: async (extension) => {
      const directory = isAbsolute(resolved.outputDir) ? resolved.outputDir : join(process.cwd(), resolved.outputDir)
      await mkdir(directory, { recursive: true })
      outputSequence++
      return join(directory, `edit-${String(Date.now())}-${String(outputSequence)}${extension}`)
    },
    canvas: () => ctx.get('canvas'),
  })
  const skills = ctx.get('skills')
  if (skills !== undefined) {
    const assetRoot = resolved.skillAssetRoot ?? fileURLToPath(new URL('../assets/media-editing/', import.meta.url))
    const path = join(assetRoot, 'SKILL.md')
    const { description } = parseMediaEditingSkill(readFileSync(path, 'utf8'), path)
    const { BUNDLED_SKILL_RANK } = await import('@deepseek-ai/dsh-skill')
    const candidate: SkillCandidate = {
      name: 'media-editing',
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-tool-media',
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: assetRoot.split(sep).join('/') },
      locator: path,
    }
    const provider: SkillProvider = {
      name: 'dsh-tool-media',
      list: () => Promise.resolve([candidate]),
      async get(skill, options) {
        const { rank: _rank, locator, ...summary } = skill
        if (typeof locator !== 'string') throw new Error('tool-media: invalid media-editing skill locator')
        const raw = await readFile(locator, { encoding: 'utf8', signal: options.signal })
        return { ...summary, content: parseMediaEditingSkill(raw, locator).content }
      },
    }
    ctx.effect(() => skills.registerProvider(() => provider), 'tool-media: media-editing skill')
  }

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
          nodeId: { type: 'string' },
          canvasError: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text', text: `Wrote ${value.path} with ${value.model}.${value.nodeId === undefined ? '' : ` Canvas node ${value.nodeId}.`}`
          + (value.canvasError === undefined ? '' : ` Canvas placement failed: ${value.canvasError}.`),
      }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      const input = args
      const gateway = await request(exec.signal)
      const audio = await generateSpeech(gateway, {
        model: resolved.speechModel,
        text: input.text,
        voice: await voiceReference(input.voice),
      })
      const path = await writeArtifact(resolved.outputDir, 'speech', audio.contentType, audio.bytes)
      const placement = await placeMediaArtifact(ctx.get('canvas'), exec.agent?.session, {
        type: 'audio', path, title: 'Speech', prompt: input.text, model: resolved.speechModel,
      })
      return { path, model: resolved.speechModel, ...placement }
    },
  }))

  const taskTool = (model: string, description: string) => ({
    name: 'generate_music',
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
          nodeId: { type: 'string' as const },
          canvasError: { type: 'string' as const },
        },
      },
      render: (_args: unknown, value: { path: string; model: string; nodeId?: string; canvasError?: string }) => [{
        type: 'text' as const, text: `Wrote ${value.path} with ${value.model}.${value.nodeId === undefined ? '' : ` Canvas node ${value.nodeId}.`}`
          + (value.canvasError === undefined ? '' : ` Canvas placement failed: ${value.canvasError}.`),
      }],
      presentationMeta: (_args: unknown, value: { path: string; model: string; nodeId?: string; canvasError?: string }) => value,
    },
    async execute(args: unknown, exec: ToolExecution) {
      const input = args as { prompt: string; lyrics?: string }
      const gateway = await request(exec.signal)
      // Music3 reads the arrangement description from request metadata and the lyrics from the prompt.
      const body: Record<string, unknown> = {
        prompt: input.prompt,
        metadata: {
          instructions: input.prompt,
          ...(input.lyrics === undefined ? {} : { lyrics: input.lyrics }),
        },
      }
      const id = await submitTask(gateway, model, body)
      const url = await awaitTask(gateway, id, { timeoutMs: resolved.taskTimeoutMs, intervalMs: resolved.pollIntervalMs })
      const media = await downloadMedia(gateway, url)
      const path = await writeArtifact(resolved.outputDir, 'music', media.contentType, media.bytes)
      const placement = await placeMediaArtifact(ctx.get('canvas'), exec.agent?.session, {
        type: 'audio', path, title: 'Music', prompt: input.prompt, model,
      })
      return { path, model, ...placement }
    },
  })

  ctx.tools.register(defineTool(taskTool(
    resolved.musicModel,
    'Generate a music track. The prompt must describe genre, instrumentation, tempo, and mood.',
  )))
}
