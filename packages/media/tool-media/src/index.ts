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

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { voiceReference } from './local-path.ts'
import { createVideoPreview } from './video-preview.ts'
import { createLegacyRunner } from './legacy-runner.ts'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { CatalogSource } from './catalog.ts'
import { registerMediaSkills, resolveSkillRoot } from './skills.ts'
import { registerEditTools } from './edit-tools.ts'
import { registerTimelineRenderTools } from './timeline-tools.ts'
import { FfmpegRunner } from './ffmpeg.ts'
import { createGenerator } from './generators.ts'
import { resolveAudioPlan } from './audio-plan.ts'
import { registerNodeTools } from './node-tools.ts'
import { MediaService } from './remote.ts'
import { LocalMediaEditor } from './local-edit.ts'
import { LocalMediaImporter } from './media-import.ts'
import { registerLocalEditTools } from './local-edit-tools.ts'
import { createNodeToolDeps } from './node-deps.ts'
import { createMediaRuntime } from './remote-runtime.ts'
import { runnerServicesOf } from './node-tools.ts'
import { recoverInterrupted } from './runner.ts'
import { TimelineRenderer } from './timeline-render.ts'
import { createTimelineCompatibility } from './timeline-compatibility.ts'
import { awaitTask, downloadMedia, generateSpeech, submitTask, type GatewayRequest } from './gateway.ts'
import { placeMediaArtifact, registerVisualTools } from './visual-tools.ts'

export { MediaGatewayError } from './gateway.ts'
export type { MediaArtifact } from './gateway.ts'
export type { MediaCapabilityView } from './types.ts'
export type * from './timeline-render-types.ts'
export type * from './local-edit-types.ts'
export { MediaService } from './remote.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-media'

/** Required tool registry and managed subprocess provider; skills are optional. */
export const inject = ['tools', 'subprocess']

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
  /** Video model used when a node has reference images but no first frame. */
  videoRefModel?: string
  /** Longest video segment one generation call may cover, in seconds. */
  maxSegmentSeconds?: number
  /** Shortest clip one storyboard-segment video call requests, in seconds. */
  minSegmentSeconds?: number
  /** Generation tasks one call may run at once. */
  generateConcurrency?: number
  /** Video calls above which a plan needs the user's confirmation. */
  confirmVideoCalls?: number
  /** Total video seconds above which a plan needs the user's confirmation. */
  confirmVideoSeconds?: number
  /** Spoken lines above which a plan needs the user's confirmation. */
  confirmSpeechLines?: number
  /** Image calls above which a plan needs the user's confirmation. */
  confirmImageCalls?: number
  /** Music calls above which a plan needs the user's confirmation. */
  confirmMusicCalls?: number
  /** FFmpeg executable, or an absolute path to its bundled runtime copy. */
  ffmpegPath?: string
  /** FFprobe executable, or an absolute path to its bundled runtime copy. */
  ffprobePath?: string
  /** Timeout for one local editing operation. */
  editTimeoutMs?: number
  /** Absolute font path injected into non-ASCII drawtext filters. */
  fontFile?: string
  /** Directory holding one subdirectory per bundled skill; relative paths resolve against this package. */
  skillsRoot?: string
  /** Video frames per reusable full-quality cache block. */
  renderChunkFrames?: number
  /** Maximum bytes in one streamed render upload. */
  renderMaxChunkBytes?: number
  /** Time without progress before a disconnected render lease is fenced and requeued. */
  renderLeaseTimeoutMs?: number
  /** Simultaneously decoded source clips permitted in a render. */
  renderMaxActiveSources?: number
  /** H.264 target bitrate per output pixel per frame. */
  renderVideoBitsPerPixel?: number
  /** Bitrate of the single final AAC mix. */
  renderAudioBitrate?: number
  /** Default browser font family for captions without an explicit font. */
  renderFontFamily?: string
  /** Optional font bytes loaded by every compositor under the same font family. */
  renderFontFile?: string
  /** Quality of immutable H.264 compatibility copies (0–51). */
  renderCompatibilityCrf?: number
  /** FFmpeg H.264 preset for compatibility copies. */
  renderCompatibilityPreset?:
    | 'ultrafast'
    | 'superfast'
    | 'veryfast'
    | 'faster'
    | 'fast'
    | 'medium'
    | 'slow'
    | 'slower'
    | 'veryslow'
  /** AAC bitrate of compatibility copies before timeline mixing. */
  renderCompatibilityAudioBitrate?: number
  /** Per-input demux byte cache. */
  renderSourceCacheBytes?: number
  /** Maximum bytes decoded as one still image or font. */
  renderMaxImageBytes?: number
  /** Maximum decoded pixel count per source. */
  renderMaxSourcePixels?: number
  /** Samples per finite audio mixing/encoding window. */
  renderAudioWindowSamples?: number
  /** Progress and renderer lease heartbeat interval. */
  renderHeartbeatMs?: number
}

/** Config fields one deployment may set; the schema below gives every default. */
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
  videoRefModel: z.string().default('minimax-h3-ref2va'),
  maxSegmentSeconds: z.number().default(15),
  minSegmentSeconds: z.number().default(4),
  generateConcurrency: z.number().default(3),
  confirmVideoCalls: z.number().default(2),
  confirmVideoSeconds: z.number().default(20),
  confirmSpeechLines: z.number().default(20),
  confirmImageCalls: z.number().default(8),
  confirmMusicCalls: z.number().default(2),
  ffmpegPath: z.string().default('ffmpeg'),
  ffprobePath: z.string().default('ffprobe'),
  editTimeoutMs: z.number().default(600_000),
  fontFile: z.string().min(1),
  skillsRoot: z.string().min(1).default('../assets/'),
  renderChunkFrames: z.number().default(120),
  renderMaxChunkBytes: z.number().default(1_048_576),
  renderLeaseTimeoutMs: z.number().default(60_000),
  renderMaxActiveSources: z.number().default(8),
  renderVideoBitsPerPixel: z.number().default(0.14),
  renderAudioBitrate: z.number().default(192_000),
  renderFontFamily: z.string().min(1).default('sans-serif'),
  renderFontFile: z.string().min(1),
  renderCompatibilityCrf: z.number().default(18),
  renderCompatibilityPreset: z
    .union(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'])
    .default('fast'),
  renderCompatibilityAudioBitrate: z.number().default(192_000),
  renderSourceCacheBytes: z.number().default(1_048_576),
  renderMaxImageBytes: z.number().default(33_554_432),
  renderMaxSourcePixels: z.number().default(16_777_216),
  renderAudioWindowSamples: z.number().default(4096),
  renderHeartbeatMs: z.number().default(2500),
})

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    media: 'media'
    'media-edit': 'media-edit'
  }
}

/** Declared config keys; a deployment that carries a retired key must fail at load instead of silently falling back. */
const CONFIG_KEYS = [
  'baseURL',
  'apiKeyEnv',
  'imageModel',
  'speechModel',
  'musicModel',
  'videoModel',
  'outputDir',
  'taskTimeoutMs',
  'pollIntervalMs',
  'catalog',
  'catalogCacheFile',
  'videoDefaultDuration',
  'videoRefModel',
  'maxSegmentSeconds',
  'minSegmentSeconds',
  'generateConcurrency',
  'confirmVideoCalls',
  'confirmVideoSeconds',
  'confirmSpeechLines',
  'confirmImageCalls',
  'confirmMusicCalls',
  'ffmpegPath',
  'ffprobePath',
  'editTimeoutMs',
  'fontFile',
  'skillsRoot',
  'renderChunkFrames',
  'renderMaxChunkBytes',
  'renderLeaseTimeoutMs',
  'renderMaxActiveSources',
  'renderVideoBitsPerPixel',
  'renderAudioBitrate',
  'renderFontFamily',
  'renderFontFile',
  'renderCompatibilityCrf',
  'renderCompatibilityPreset',
  'renderCompatibilityAudioBitrate',
  'renderSourceCacheBytes',
  'renderMaxImageBytes',
  'renderMaxSourcePixels',
  'renderAudioWindowSamples',
  'renderHeartbeatMs',
] as const satisfies readonly (keyof Config)[]

/**
 * Reject a config key this build does not declare.
 * @param config - deployment config as the Loader passed it.
 * @throws Error naming the unknown key.
 */
function rejectUnknownKeys(config: Config): void {
  for (const key of Object.keys(config)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new Error(`tool-media: unknown config key ${key}`)
  }
}

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Omit<Config, 'fontFile' | 'renderFontFile'>> &
  Pick<Config, 'fontFile' | 'renderFontFile'>

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
    throw new Error(
      `tool-media: no API key for ${ref}; store it through the credentials service or export it in the launching environment`,
    )
  }
  return ambient
}

/**
 * Write one media artifact under the configured output directory.
 * @param root - configured output directory.
 * @param prefix - file-name prefix naming the producing tool.
 * @param contentType - response content type.
 * @param bytes - media bytes.
 * @param onPath - checkpoint the destination before publishing the complete file.
 * @returns the absolute written path.
 */
async function writeArtifact(
  root: string,
  prefix: string,
  contentType: string,
  bytes: Uint8Array,
  onPath?: (path: string) => Promise<void>,
): Promise<string> {
  const directory = isAbsolute(root) ? root : join(process.cwd(), root)
  await mkdir(directory, { recursive: true })
  // Content-addressed names keep two runs that produce the same bytes in the same place.
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const path = join(directory, `${prefix}-${digest}${extensionFor(contentType)}`)
  await onPath?.(path)
  await writeFileAtomic(path, bytes, { mode: 0o666 })
  return path
}

/**
 * Register the media tools.
 * @param ctx - context whose tools registry receives the registrations.
 * @param config - deployment configuration with every default applied.
 */
export function apply(ctx: Context, config: Config): void {
  rejectUnknownKeys(config)
  const resolved = Config(config) as ResolvedConfig
  if (resolved.fontFile !== undefined && !isAbsolute(resolved.fontFile)) {
    throw new Error('tool-media fontFile must be an absolute path')
  }
  for (const field of [
    'renderChunkFrames',
    'renderMaxChunkBytes',
    'renderLeaseTimeoutMs',
    'renderMaxActiveSources',
    'renderAudioBitrate',
    'renderCompatibilityAudioBitrate',
    'renderSourceCacheBytes',
    'renderMaxImageBytes',
    'renderMaxSourcePixels',
    'renderAudioWindowSamples',
    'renderHeartbeatMs',
  ] as const) {
    if (!Number.isSafeInteger(resolved[field]) || resolved[field] <= 0)
      throw new Error(`tool-media ${field} must be a positive integer`)
  }
  if (!Number.isFinite(resolved.renderVideoBitsPerPixel) || resolved.renderVideoBitsPerPixel <= 0)
    throw new Error('tool-media renderVideoBitsPerPixel must be positive')
  if (resolved.renderFontFile !== undefined && !isAbsolute(resolved.renderFontFile))
    throw new Error('tool-media renderFontFile must be an absolute path')
  if (
    !Number.isInteger(resolved.renderCompatibilityCrf) ||
    resolved.renderCompatibilityCrf < 0 ||
    resolved.renderCompatibilityCrf > 51
  )
    throw new Error('tool-media renderCompatibilityCrf must be an integer from 0 through 51')
  if (resolved.renderHeartbeatMs * 2 >= resolved.renderLeaseTimeoutMs)
    throw new Error('tool-media renderHeartbeatMs must be less than half the lease timeout')
  if (resolved.renderMaxChunkBytes < 8)
    throw new Error('tool-media renderMaxChunkBytes must fit at least one stereo Float32 sample')
  const ref = credentialRef(resolved.apiKeyEnv)
  const request = async (signal: AbortSignal): Promise<GatewayRequest> => ({
    baseURL: resolved.baseURL,
    apiKey: await resolveKey(ctx, ref),
    signal,
  })

  const cacheFile =
    resolved.catalogCacheFile !== ''
      ? resolved.catalogCacheFile
      : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'ov-catalog.json')
  let outputSequence = 0
  const ffmpeg = new FfmpegRunner(ctx.subprocess, resolved.ffmpegPath, resolved.ffprobePath, resolved.editTimeoutMs)
  const previewVideo = createVideoPreview(
    ffmpeg,
    isAbsolute(resolved.outputDir) ? resolved.outputDir : join(process.cwd(), resolved.outputDir),
  )
  ctx.effect(
    () => async () => {
      const previews = previewVideo.dispose()
      try {
        await ffmpeg.dispose()
      } finally {
        await previews
      }
    },
    'tool-media: local processes and previews',
  )
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
  const catalogOf = async (): Promise<import('./catalog.ts').MediaCatalog | undefined> => {
    if (!resolved.catalog) return undefined
    const gateway = await request(AbortSignal.timeout(resolved.taskTimeoutMs))
    return new CatalogSource({ baseURL: resolved.baseURL, cacheFile }).load(gateway.apiKey, gateway.signal)
  }
  const generator = createGenerator({
    request,
    ...(resolved.catalog
      ? {
        catalog: async () => {
          const gateway = await request(AbortSignal.timeout(resolved.taskTimeoutMs))
          return new CatalogSource({ baseURL: resolved.baseURL, cacheFile }).load(gateway.apiKey, gateway.signal)
        },
      }
      : {}),
    write: (prefix, contentType, bytes, onPath) =>
      writeArtifact(resolved.outputDir, prefix, contentType, bytes, onPath),
    taskTimeoutMs: resolved.taskTimeoutMs,
    pollIntervalMs: resolved.pollIntervalMs,
    videoDefaultDuration: resolved.videoDefaultDuration,
    videoModel: resolved.videoModel,
    videoRefModel: resolved.videoRefModel,
  })
  const jobsRegistry = ctx.get('jobs')
  const nodeToolDeps = createNodeToolDeps({
    canvas: () => ctx.get('canvas'),
    resolved,
    generator,
    ffmpeg,
    jobs:
      jobsRegistry === undefined
        ? undefined
        : {
          start: spec => jobsRegistry.start(spec),
          live: owner =>
            jobsRegistry
              .list(owner)
              .filter(job => job.status === 'running' || job.status === 'stopping')
              .map(job => job.id),
        },
  })
  const runLegacy = createLegacyRunner(nodeToolDeps, jobsRegistry)
  registerVisualTools(ctx, {
    request,
    runLegacy,
    catalog: resolved.catalog ? new CatalogSource({ baseURL: resolved.baseURL, cacheFile }) : undefined,
    imageModel: resolved.imageModel,
    videoModel: resolved.videoModel,
    videoDefaultDuration: resolved.videoDefaultDuration,
    taskTimeoutMs: resolved.taskTimeoutMs,
    pollIntervalMs: resolved.pollIntervalMs,
    write: (prefix, contentType, bytes) => writeArtifact(resolved.outputDir, prefix, contentType, bytes),
    canvas: () => ctx.get('canvas'),
  })
  registerNodeTools(ctx, nodeToolDeps)
  const canvasOf = (): import('@deepseek-ai/dsh-canvas').CanvasService => {
    const canvas = ctx.get('canvas')
    /* v8 ignore next -- the deployment enables the canvas row with these tools */
    if (canvas === undefined) throw new Error('tool-media: the canvas service is not available')
    return canvas
  }
  const opened = new Map<string, Promise<void>>()
  const localEditor = new LocalMediaEditor({
    canvas: canvasOf,
    jobs: nodeToolDeps.jobs,
    ffmpeg,
    outputDir: resolved.outputDir,
    report: (error) => { ctx.logger.warn(error) },
  })
  const mediaImporter = new LocalMediaImporter({
    canvas: canvasOf,
    jobs: nodeToolDeps.jobs,
    ffmpeg,
    report: (error) => { ctx.logger.warn(error) },
  })
  registerLocalEditTools(ctx, localEditor)
  const compatibility = {
    crf: resolved.renderCompatibilityCrf,
    preset: resolved.renderCompatibilityPreset,
    audioBitrate: resolved.renderCompatibilityAudioBitrate,
  }
  const compatible = createTimelineCompatibility(ffmpeg, compatibility)
  const renderer = new TimelineRenderer({
    canvas: canvasOf,
    ffmpeg,
    jobs: jobsRegistry,
    compatible,
    config: {
      chunkFrames: resolved.renderChunkFrames,
      maxChunkBytes: resolved.renderMaxChunkBytes,
      leaseTimeoutMs: resolved.renderLeaseTimeoutMs,
      maxActiveSources: resolved.renderMaxActiveSources,
      videoBitsPerPixel: resolved.renderVideoBitsPerPixel,
      audioBitrate: resolved.renderAudioBitrate,
      fontFamily: resolved.renderFontFamily,
      compatibility,
      sourceCacheBytes: resolved.renderSourceCacheBytes,
      maxImageBytes: resolved.renderMaxImageBytes,
      maxSourcePixels: resolved.renderMaxSourcePixels,
      audioWindowSamples: resolved.renderAudioWindowSamples,
      heartbeatMs: resolved.renderHeartbeatMs,
      ...(resolved.renderFontFile === undefined ? {} : { fontFile: resolved.renderFontFile }),
    },
    notify: (notice) => { ctx.emit('media/render-change', notice) },
    report: (error) => { ctx.logger.warn(error) },
  })
  registerTimelineRenderTools(ctx, renderer)
  ctx.effect(() => {
    const timer = setInterval(() => {
      void renderer.expireLeases().catch((error: unknown) => { ctx.logger.warn(error) })
    }, resolved.renderLeaseTimeoutMs / 3)
    timer.unref()
    return async () => {
      clearInterval(timer)
      try {
        await renderer.dispose()
      } finally {
        await compatible.dispose()
      }
    }
  }, 'tool-media.timeline-renderer')
  ctx.on('canvas/open', async (session, episode) => {
    const services = await runnerServicesOf(canvasOf, nodeToolDeps, session, episode)
    const target = await canvasOf().targetOf(session, episode)
    const scope = join(target.directory, '.canvas', target.file)
    let recovery = opened.get(scope)
    if (recovery === undefined) {
      recovery = recoverInterrupted(services).then(() => renderer.recover(session, episode))
      opened.set(scope, recovery)
      void recovery.catch((_error: unknown) => {
        opened.delete(scope)
      }) // The open request exposes failure and permits explicit retry.
    }
    await recovery
  })
  void new MediaService(
    ctx,
    catalogOf,
    createMediaRuntime({
      canvasOf,
      tools: {
        ...nodeToolDeps,
        jobs: (session) => {
          const jobs = nodeToolDeps.jobs(session)
          return { ...jobs, start: spec => jobs.start({ ...spec, completionNotice: 'none' }) }
        },
      },
      previewVideo,
      jobs:
        jobsRegistry === undefined
          ? undefined
          : { kill: (id, caller, reason) => jobsRegistry.kill(id, caller, reason) },
    }),
    renderer,
    localEditor,
    mediaImporter,
  )
  const skills = ctx.get('skills')
  if (skills !== undefined) registerMediaSkills(ctx, skills, resolveSkillRoot(resolved.skillsRoot))

  ctx.tools.register(
    defineTool({
      name: 'generate_speech',
      description: 'Synthesize speech from text with a reference voice sample.',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to speak.' },
        voice: {
          type: 'string',
          required: true,
          description:
            'Reference voice: an audio file path, HTTP(S) URL, or data URI. The clip must be 30 seconds or shorter.',
        },
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
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Wrote ${value.path} with ${value.model}.${value.nodeId === undefined ? '' : ` Canvas node ${value.nodeId}.`}` +
              (value.canvasError === undefined ? '' : ` Canvas placement failed: ${value.canvasError}.`),
          },
        ],
        presentationMeta: (_args, value) => value,
      },
      async execute(args, exec) {
        const input = args
        const durable = await runLegacy(
          { kind: 'speech', prompt: input.text, model: resolved.speechModel, params: { voice: input.voice } },
          exec,
        )
        if (durable !== undefined) return durable
        const gateway = await request(exec.signal)
        const audio = await generateSpeech(gateway, {
          model: resolved.speechModel,
          text: input.text,
          voice: await voiceReference(input.voice),
        })
        const path = await writeArtifact(resolved.outputDir, 'speech', audio.contentType, audio.bytes)
        const placement = await placeMediaArtifact(ctx.get('canvas'), exec.agent?.session, {
          type: 'audio',
          kind: 'speech',
          path,
          title: 'Speech',
          prompt: input.text,
          model: resolved.speechModel,
        })
        return { path, model: resolved.speechModel, ...placement }
      },
    }),
  )

  const taskTool = (model: string, description: string) => ({
    name: 'generate_music',
    description,
    parameters: {
      prompt: {
        type: 'string' as const,
        required: true as const,
        description: 'What to produce, including style, instruments, tempo, and mood for music.',
      },
      lyrics: {
        type: 'string' as const,
        description:
          'Song lyrics; required by MiniMax Music3. Omit for instrumental creation with a model such as ACE-Step.',
      },
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
      render: (_args: unknown, value: { path: string; model: string; nodeId?: string; canvasError?: string }) => [
        {
          type: 'text' as const,
          text:
            `Wrote ${value.path} with ${value.model}.${value.nodeId === undefined ? '' : ` Canvas node ${value.nodeId}.`}` +
            (value.canvasError === undefined ? '' : ` Canvas placement failed: ${value.canvasError}.`),
        },
      ],
      presentationMeta: (
        _args: unknown,
        value: { path: string; model: string; nodeId?: string; canvasError?: string },
      ) => value,
    },
    async execute(args: unknown, exec: ToolExecution) {
      const input = args as { prompt: string; lyrics?: string }
      const durable = await runLegacy(
        {
          kind: 'music',
          prompt: input.prompt,
          model,
          params: {
            ...(input.lyrics === undefined ? {} : { lyrics: input.lyrics }),
          },
        },
        exec,
      )
      if (durable !== undefined) return durable
      const plan = resolveAudioPlan({
        kind: 'music',
        model,
        prompt: input.prompt,
        params: {
          ...(input.lyrics === undefined ? {} : { lyrics: input.lyrics }),
        },
      })
      if (plan.transport !== 'videos_task') throw new Error('Music planning returned a speech transport')
      const gateway = await request(exec.signal)
      const body: Record<string, unknown> = {
        prompt: plan.prompt,
        metadata: plan.metadata,
      }
      const id = await submitTask(gateway, model, body)
      const url = await awaitTask(gateway, id, {
        timeoutMs: resolved.taskTimeoutMs,
        intervalMs: resolved.pollIntervalMs,
      })
      const media = await downloadMedia(gateway, url)
      const path = await writeArtifact(resolved.outputDir, 'music', media.contentType, media.bytes)
      const placement = await placeMediaArtifact(ctx.get('canvas'), exec.agent?.session, {
        type: 'audio',
        kind: 'music',
        path,
        title: 'Music',
        prompt: input.prompt,
        model,
      })
      return { path, model, ...placement }
    },
  })

  ctx.tools.register(
    defineTool(
      taskTool(
        resolved.musicModel,
        'Generate a music track. The prompt must describe genre, instrumentation, tempo, and mood.',
      ),
    ),
  )
}
