import path from 'node:path'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

const MAX_CONCURRENT_JOBS = 2
const OUTPUT_LIMIT = 4 * 1024 * 1024
const ERROR_TAIL_LIMIT = 2_000
const TERMINATION_GRACE_MS = 500

/** Failure kinds one FFmpeg or FFprobe run can report. */
export type FfmpegErrorCode = 'binary-not-found' | 'timeout' | 'aborted' | 'process-exit' | 'disposed' | 'invalid-probe' | 'cleanup-failed'

/** One failed FFmpeg or FFprobe run, carrying its kind. */
export class FfmpegError extends Error {
  /**
   * @param code - failure kind.
   * @param message - diagnostic text shown to the model.
   * @param options - standard error options, such as a cause.
   */
  constructor(readonly code: FfmpegErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FfmpegError'
  }
}

/** Options one FFmpeg or FFprobe run accepts. */
export interface FfmpegRunOptions {
  readonly signal?: AbortSignal
  readonly cwd?: string
  readonly timeoutMs?: number
}

/** Frame counting decodes the first video stream to identify its exact final frame, including VFR sources. */
export interface FfprobeRunOptions extends FfmpegRunOptions {
  readonly countVideoFrames?: boolean
}

/** Output one FFmpeg run captured. */
export interface FfmpegRunResult {
  /** Standard output, limited to the tail this package retains. */
  readonly stdout: string
  /** Standard error, limited to the tail this package retains. */
  readonly stderr: string
}

/** The subset of ffprobe's JSON that this package reads. */
export interface FfprobeDocument {
  readonly streams?: readonly {
    readonly index?: number
    readonly codec_type?: string
    readonly codec_name?: string
    readonly width?: number
    readonly height?: number
    readonly r_frame_rate?: string
    readonly avg_frame_rate?: string
    readonly nb_frames?: string
    readonly nb_read_frames?: string
    readonly sample_rate?: string
    readonly channels?: number
    readonly channel_layout?: string
    readonly duration?: string
  }[]
  readonly format?: {
    readonly format_name?: string
    readonly duration?: string
    readonly size?: string
    readonly bit_rate?: string
  }
}

/**
 * Resolve an exact zero-based final frame index from a counted video stream. Container duration
 * and nominal frame rate cannot identify the last decoded frame of a VFR source.
 * @param probe - FFprobe document obtained with countVideoFrames enabled.
 * @returns the index of its final decoded video frame.
 * @throws FfmpegError when counting did not produce a positive safe integer.
 */
export function lastVideoFrameIndex(probe: FfprobeDocument): number {
  const frames = Number(probe.streams?.find(stream => stream.codec_type === 'video')?.nb_read_frames)
  if (!Number.isSafeInteger(frames) || frames < 1) throw new FfmpegError('invalid-probe', 'The source has no counted decodable video frames')
  return frames - 1
}

interface Waiter {
  readonly resolve: () => void
  readonly reject: (error: FfmpegError) => void
  readonly signal: AbortSignal | undefined
  abort?: () => void
}

function processError(bin: string, error: unknown): FfmpegError {
  const missing = error instanceof SubprocessExecutableNotFoundError
    || (error instanceof Error && 'code' in error && error.code === 'ENOENT')
  if (missing) {
    const binary = path.basename(bin) === 'ffprobe' || path.basename(bin) === 'ffprobe.exe' ? 'ffprobe' : 'ffmpeg'
    return new FfmpegError('binary-not-found', `未找到 ${binary}，请安装或配置 ${binary === 'ffprobe' ? 'ffprobePath' : 'ffmpegPath'}`, { cause: error })
  }
  const message = error instanceof Error ? error.message : 'Unknown subprocess failure'
  return new FfmpegError('process-exit', `${path.basename(bin)} could not start: ${message}`, { cause: error })
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FfmpegError('aborted', 'ffmpeg operation was aborted', { cause: signal.reason })
}

/** Runs FFmpeg and FFprobe as managed process ranges under one concurrency bound. */
export class FfmpegRunner {
  private readonly children = new Map<SubprocessHandle, (error: FfmpegError) => void>()
  private readonly waiters: Waiter[] = []
  private readonly pending = new Set<Promise<unknown>>()
  private active = 0
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>,
    readonly ffmpegPath = 'ffmpeg',
    readonly ffprobePath = 'ffprobe',
    readonly timeoutMs = 600_000,
  ) {}

  /**
   * Run FFmpeg with one argument list.
   * @param args - arguments after the executable name.
   * @param options - cancellation and other run options.
   * @returns the exit code and captured output.
   * @throws `FfmpegError` when the binary is missing, times out, or exits non-zero.
   */
  exec(args: readonly string[], options: FfmpegRunOptions = {}): Promise<FfmpegRunResult> {
    return this.admit(() => this.run(this.ffmpegPath, args, options), options.signal)
  }

  /**
   * Read one file's streams and container data.
   * @param pathname - file to inspect.
   * @param options - cancellation and other run options.
   * @returns the parsed ffprobe document.
   * @throws `FfmpegError` `invalid-probe` when ffprobe does not return JSON.
   */
  probe(pathname: string, options: FfprobeRunOptions = {}): Promise<FfprobeDocument> {
    return this.admit(async () => {
      const result = await this.run(this.ffprobePath, [
        ...options.countVideoFrames === true ? ['-count_frames', '-select_streams', 'v:0'] : [],
        '-v', 'error', '-show_streams', '-show_format', '-of', 'json', pathname,
      ], options, true)
      try {
        return JSON.parse(result.stdout) as FfprobeDocument
      } catch (error: unknown) {
        throw new FfmpegError('invalid-probe', `ffprobe returned invalid JSON for ${pathname}`, { cause: error })
      }
    }, options.signal)
  }

  /** Stop admission, terminate managed ranges, and await every accepted operation.
   * @returns the same drain promise for repeated disposal requests.
   * @throws `FfmpegError` `cleanup-failed` if a process range cannot be confirmed empty.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.disposal = Promise.allSettled(this.pending).then(async () => {
      const ranges = await Promise.allSettled([...this.children.keys()].map(child =>
        Promise.resolve().then(() => child.waitForExit())))
      const failures = ranges.flatMap((result): unknown[] => result.status === 'rejected'
        ? [result.reason]
        : result.value ? [] : [new Error('FFmpeg subprocess range did not stop')])
      if (failures.length > 0) {
        throw new FfmpegError('cleanup-failed', 'FFmpeg subprocess cleanup failed', { cause: new AggregateError(failures) })
      }
    })
    for (const stop of this.children.values()) {
      stop(new FfmpegError('disposed', 'ffmpeg runner was disposed'))
    }
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.abort !== undefined) waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(new FfmpegError('disposed', 'ffmpeg runner was disposed'))
    }
    return this.disposal
  }

  private admit<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) return Promise.reject(new FfmpegError('disposed', 'ffmpeg runner was disposed'))
    const pending = (async () => {
      await this.acquire(signal)
      try { return await operation() }
      finally { this.release() }
    })()
    this.pending.add(pending)
    const finish = (): void => { this.pending.delete(pending) }
    void pending.then(finish, finish)
    return pending
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new FfmpegError('disposed', 'ffmpeg runner was disposed')
    if (signal?.aborted) throw new FfmpegError('aborted', 'ffmpeg operation was aborted', { cause: signal.reason })
    if (this.active < MAX_CONCURRENT_JOBS) {
      this.active++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal }
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter)
          this.waiters.splice(index, 1)
          reject(new FfmpegError('aborted', 'ffmpeg operation was aborted', { cause: signal.reason }))
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) {
      if (next.signal !== undefined && next.abort !== undefined) next.signal.removeEventListener('abort', next.abort)
      next.resolve()
    } else this.active--
  }

  private checkAdmission(signal: AbortSignal | undefined): void {
    if (this.disposed) throw new FfmpegError('disposed', 'ffmpeg runner was disposed')
    checkAbort(signal)
  }

  private async run(
    bin: string,
    args: readonly string[],
    options: FfmpegRunOptions,
    probe = false,
  ): Promise<FfmpegRunResult> {
    this.checkAdmission(options.signal)
    let executable: string
    try {
      executable = await this.subprocess.resolveExecutable(bin, undefined, options.signal)
    } catch (error: unknown) {
      checkAbort(options.signal)
      throw processError(bin, error)
    }
    this.checkAdmission(options.signal)
    return new Promise((resolve, reject) => {
      let child: SubprocessHandle
      try {
        child = this.subprocess.spawn({
          argv: [executable, ...args], cwd: options.cwd ?? process.cwd(), graceMs: TERMINATION_GRACE_MS,
          stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_LIMIT }, stderr: { maxBytes: OUTPUT_LIMIT } },
        })
      } catch (error: unknown) {
        reject(processError(bin, error))
        return
      }
      let pending: FfmpegError | undefined
      let outcome: SubprocessOutcome | undefined
      let directSettled = false
      let quiescent = false
      let settled = false
      const signal = options.signal
      const timeoutMs = options.timeoutMs ?? (probe ? Math.min(this.timeoutMs, 30_000) : this.timeoutMs)
      const timer = setTimeout(() => {
        stop(new FfmpegError('timeout', `${path.basename(bin)} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref()
      const onAbort = (): void => {
        stop(new FfmpegError('aborted', 'ffmpeg operation was aborted', { cause: signal?.reason }))
      }
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (quiescent) this.children.delete(child)
        callback()
      }
      const unobservable = (cause: unknown): void => {
        // The provider retains the range for its own finalization. This owner cannot
        // safely admit replacements after losing proof of the previous work's exit.
        this.disposed = true
        finish(() => {
          reject(new FfmpegError('cleanup-failed', 'Could not confirm FFmpeg processes exited; restart the Host before retrying', { cause }))
        })
      }
      const stop = (error: FfmpegError): void => {
        pending ??= error
        try { child.terminate() }
        catch (cause: unknown) { unobservable(cause) }
      }
      const complete = (): void => {
        if (!directSettled || !quiescent || settled) return
        if (pending !== undefined) {
          const error = pending
          finish(() => { reject(error) })
          return
        }
        let out: string
        let err: string
        try {
          out = child.collected.stdout?.readFrom(0).text ?? ''
          err = child.collected.stderr?.readFrom(0).text ?? ''
        } catch (cause: unknown) {
          finish(() => { reject(new FfmpegError('process-exit', 'Could not read FFmpeg subprocess output', { cause })) })
          return
        }
        if (outcome?.exitCode === 0) {
          finish(() => { resolve({ stdout: out, stderr: err }) })
          return
        }
        const tail = err.trim().slice(-ERROR_TAIL_LIMIT)
        const status = outcome?.exitCode ?? outcome?.signal
        finish(() => {
          reject(new FfmpegError('process-exit', `${path.basename(bin)} exited with ${status}${tail === '' ? '' : `: ${tail}`}`))
        })
      }
      this.children.set(child, stop)
      signal?.addEventListener('abort', onAbort, { once: true })
      void child.done.then((result) => {
        outcome = result
        directSettled = true
        complete()
      }, (error: unknown) => {
        pending ??= processError(bin, error)
        directSettled = true
        complete()
      })
      void Promise.resolve().then(() => child.waitForExit()).then((empty) => {
        if (!empty) { unobservable(new Error('FFmpeg subprocess range wait ended before exit')); return }
        quiescent = true
        complete()
      }, unobservable)
      // A provider may synchronously reenter cancellation while returning its handle.
      if (this.disposed) stop(new FfmpegError('disposed', 'ffmpeg runner was disposed'))
      else if (signal?.aborted) onAbort()
    })
  }
}
