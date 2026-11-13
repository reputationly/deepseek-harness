/** Node-tool dependencies assembled from the deployment config and the services this plugin found. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { CanvasService } from '@deepseek-ai/dsh-canvas'
import type { JobHandle, JobId } from '@deepseek-ai/dsh-jobs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { NodeToolDeps } from './node-tools.ts'
import type { GeneratedMedia, MediaGenerator, MediaJob } from './runner.ts'

/** Media jobs registry this plugin registers through. */
export interface JobsRegistry {
  start(spec: {
    readonly kind: 'media'
    readonly label: string
    readonly owner: Session['id']
    readonly run: (job: JobHandle) => {
      readonly cancel: (reason?: string) => void
      readonly done: Promise<{ readonly status: 'completed'; readonly result: string }
      | { readonly status: 'failed'; readonly detail: string }>
    }
  }): JobId
}

/** FFmpeg operations the node tools need. */
export interface FfmpegPort {
  probe(path: string): Promise<{
    readonly streams?: readonly {
      readonly codec_type?: string
      readonly duration?: string
      readonly width?: number
      readonly height?: number
    }[]
    readonly format?: { readonly duration?: string }
  }>
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
  readonly run: (signal: AbortSignal) => Promise<GeneratedMedia>
}): MediaJob {
  const owner = session.id
  let settle: (value: GeneratedMedia) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const done = new Promise<GeneratedMedia>((resolve, fail) => { settle = resolve; reject = fail })
  const controller = new AbortController()
  const id = registry.start({
    kind: 'media',
    label: spec.label,
    owner,
    run: (job: JobHandle) => {
      job.append(`generating ${spec.label}\n`, { channel: 'log' })
      spec.run(controller.signal).then((value) => {
        settle(value)
        job.append(`wrote ${value.path}\n`, { channel: 'log' })
      }, (error: unknown) => {
        reject(error)
        job.append(`${error instanceof Error ? error.message : String(error)}\n`, { channel: 'log' })
      })
      return {
        cancel: (reason?: string) => controller.abort(reason),
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
      const scratch = join(directory, 'tail-scratch.png')
      await ffmpeg.exec(['-sseof', '-0.05', '-i', path, '-frames:v', '1', '-y', scratch])
      const bytes = await readFile(scratch)
      const target = join(directory, `tail-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.png`)
      await rename(scratch, target)
      return target
    },
  }
}
