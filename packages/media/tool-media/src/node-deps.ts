/** Node-tool dependencies assembled from the deployment config and the services this plugin found. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CanvasService } from '@deepseek-ai/dsh-canvas'
import type { JobHandle, JobHooks, JobId } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { NodeToolDeps } from './node-tools.ts'
import { createRunnerState, MediaInterruptedError, type GeneratedMedia, type MediaGenerator, type MediaJob } from './runner.ts'
import { lastVideoFrameIndex, type FfprobeDocument, type FfprobeRunOptions } from './ffmpeg.ts'

/** Media jobs registry this plugin registers through. */
export interface JobsRegistry {
  /** Live job ids from the Host registry, including producers still stopping. */
  live?(owner: Session['id']): readonly string[]
  /**
   * Register a Session-owned media job with its producer's completion policy.
   * @param spec - owner, job identity, notification policy, and execution hooks.
   * @returns the registry-issued job id.
   */
  start(spec: {
    readonly kind: 'media' | 'media-edit'
    readonly label: string
    readonly owner: Session['id']
    readonly completionNotice?: 'none'
    readonly run: (job: JobHandle) => {
      readonly cancel: JobHooks['cancel']
      readonly done: Promise<{ readonly status: 'completed'; readonly result: string }
      | { readonly status: 'failed'; readonly detail: string }>
    }
  }): JobId
}

/** FFmpeg operations the node tools need. */
export interface FfmpegPort {
  probe(path: string, options?: FfprobeRunOptions): Promise<FfprobeDocument>
  exec(args: readonly string[]): Promise<unknown>
}

/** Deployment values the node tools read. */
export interface NodeDepsConfig {
  readonly maxSegmentSeconds: number
  readonly videoDefaultDuration: number
  readonly videoModel: string
  readonly videoRefModel: string
  readonly imageModel: string
  readonly speechModel: string
  readonly musicModel: string
  readonly confirmVideoCalls: number
  readonly confirmVideoSeconds: number
  readonly confirmSpeechLines: number
  readonly confirmImageCalls: number
  readonly confirmMusicCalls: number
  readonly generateConcurrency: number
  readonly outputDir: string
}

/** Inputs the factory needs. */
export interface NodeDepsInput {
  readonly canvas: () => CanvasService | undefined
  readonly resolved: NodeDepsConfig
  readonly generator: MediaGenerator
  readonly jobs: JobsRegistry | undefined
  readonly ffmpeg: FfmpegPort
}

/** One job wrapper that reports progress and settles the run promise. */
function mediaJobOf(registry: JobsRegistry, session: Session, spec: {
  readonly label: string
  readonly local?: true
  readonly completionNotice?: 'none'
  readonly run: (signal: AbortSignal) => Promise<GeneratedMedia>
}): MediaJob {
  const owner = session.id
  let settle: (value: GeneratedMedia) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const done = new Promise<GeneratedMedia>((resolve, fail) => { settle = resolve; reject = fail })
  const controller = new AbortController()
  const id = registry.start({
    kind: spec.local === true ? 'media-edit' : 'media',
    label: spec.label,
    owner,
    ...spec.completionNotice === undefined ? {} : { completionNotice: spec.completionNotice },
    run: (job: JobHandle) => {
      job.append(`${spec.local === true ? 'processing local media' : 'generating'} ${spec.label}\n`, { channel: 'log' })
      spec.run(controller.signal).then((value) => {
        settle(value)
        job.append(`wrote ${value.path}\n`, { channel: 'log' })
      }, (error: unknown) => {
        reject(error)
        job.append(`${error instanceof Error ? error.message : String(error)}\n`, { channel: 'log' })
      })
      return {
        cancel: (reason, cause) => { controller.abort(cause === 'teardown' && spec.local !== true ? new MediaInterruptedError(reason) : reason) },
        done: done.then(
          value => ({ status: 'completed' as const, result: value.path }),
          (error: unknown) => ({ status: 'failed' as const, detail: error instanceof Error ? error.message : String(error) }),
        ),
      }
    },
  })
  return { id, done, signal: controller.signal }
}

/**
 * Build the node tools' dependencies.
 * @param input - canvas access, deployment values, generator, jobs, and ffmpeg.
 * @returns the dependency table the node tools read.
 */
export function createNodeToolDeps(input: NodeDepsInput): NodeToolDeps {
  const { canvas, resolved, generator, jobs, ffmpeg } = input
  return {
    state: createRunnerState(),
    canvas,
    limits: {
      maxVideoSeconds: resolved.maxSegmentSeconds,
      videoDefaultDuration: resolved.videoDefaultDuration,
      videoModel: resolved.videoModel,
      videoRefModel: resolved.videoRefModel,
      imageModel: resolved.imageModel,
      speechModel: resolved.speechModel,
      musicModel: resolved.musicModel,
    },
    confirmLimits: {
      confirmVideoCalls: resolved.confirmVideoCalls,
      confirmVideoSeconds: resolved.confirmVideoSeconds,
      confirmSpeechLines: resolved.confirmSpeechLines,
      confirmImageCalls: resolved.confirmImageCalls,
      confirmMusicCalls: resolved.confirmMusicCalls,
    },
    concurrency: resolved.generateConcurrency,
    generate: generator,
    jobs: session => ({
      live: () => jobs?.live?.(session.id) ?? [],
      start: (spec) => {
        /* v8 ignore next -- the composition enables the jobs row with these tools */
        if (jobs === undefined) throw new Error('tool-media: the jobs service is not available')
        return mediaJobOf(jobs, session, spec)
      },
    }),
    probe: async (path) => {
      const probe = await ffmpeg.probe(path)
      const stream = probe.streams?.find(entry => entry.codec_type === 'video')
      const duration = Number(probe.format?.duration ?? stream?.duration ?? 0)
      return {
        ...Number.isFinite(duration) && duration > 0 ? { durationMs: Math.round(duration * 1000) } : {},
        ...stream?.width === undefined ? {} : { width: stream.width },
        ...stream?.height === undefined ? {} : { height: stream.height },
      }
    },
    tailFrame: async (path) => {
      const directory = isAbsolute(resolved.outputDir) ? resolved.outputDir : join(process.cwd(), resolved.outputDir)
      await mkdir(directory, { recursive: true })
      const scratch = join(directory, `tail-${randomUUID()}.tmp.png`)
      try {
        const frame = lastVideoFrameIndex(await ffmpeg.probe(path, { countVideoFrames: true }))
        await ffmpeg.exec(['-i', path, '-map', '0:v:0', '-an', '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-fps_mode', 'vfr', '-y', scratch])
        const bytes = await readFile(scratch)
        const target = join(directory, `tail-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.png`)
        await writeFileAtomic(target, bytes, { mode: 0o666 })
        return target
      } finally {
        await rm(scratch, { force: true })
      }
    },
  }
}
