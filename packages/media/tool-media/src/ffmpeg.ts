import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

const MAX_CONCURRENT_JOBS = 2
const OUTPUT_LIMIT = 4 * 1024 * 1024
const ERROR_TAIL_LIMIT = 2_000

export type FfmpegErrorCode = 'binary-not-found' | 'timeout' | 'aborted' | 'process-exit' | 'disposed' | 'invalid-probe'

export class FfmpegError extends Error {
  constructor(readonly code: FfmpegErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FfmpegError'
  }
}

export interface FfmpegRunOptions {
  readonly signal?: AbortSignal
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface FfmpegRunResult {
  readonly stdout: string
  readonly stderr: string
}

export interface FfprobeDocument {
  readonly streams?: readonly {
    readonly index?: number
    readonly codec_type?: string
    readonly codec_name?: string
    readonly width?: number
    readonly height?: number
    readonly r_frame_rate?: string
    readonly avg_frame_rate?: string
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

interface Waiter {
  readonly resolve: () => void
  readonly reject: (error: FfmpegError) => void
  readonly signal: AbortSignal | undefined
  abort?: () => void
}

function appendTail(chunks: Buffer[], currentBytes: number, chunk: Buffer): number {
  chunks.push(chunk)
  let size = currentBytes + chunk.byteLength
  while (size > OUTPUT_LIMIT && chunks.length > 0) {
    const first = chunks[0] as Buffer
    const excess = size - OUTPUT_LIMIT
    if (first.byteLength <= excess) {
      chunks.shift()
      size -= first.byteLength
    } else {
      chunks[0] = first.subarray(excess)
      size -= excess
    }
  }
  return size
}

function processError(bin: string, error: NodeJS.ErrnoException): FfmpegError {
  if (error.code === 'ENOENT') {
    const binary = path.basename(bin) === 'ffprobe' || path.basename(bin) === 'ffprobe.exe' ? 'ffprobe' : 'ffmpeg'
    return new FfmpegError('binary-not-found', `未找到 ${binary}，请安装或配置 ${binary === 'ffprobe' ? 'ffprobePath' : 'ffmpegPath'}`, { cause: error })
  }
  return new FfmpegError('process-exit', `${path.basename(bin)} could not start: ${error.message}`, { cause: error })
}

export class FfmpegRunner {
  private readonly children = new Set<ChildProcess>()
  private readonly waiters: Waiter[] = []
  private active = 0
  private disposed = false

  constructor(
    readonly ffmpegPath = 'ffmpeg',
    readonly ffprobePath = 'ffprobe',
    readonly timeoutMs = 600_000,
  ) {}

  async exec(args: readonly string[], options: FfmpegRunOptions = {}): Promise<FfmpegRunResult> {
    const signal = options.signal
    await this.acquire(signal)
    try {
      return await this.run(this.ffmpegPath, args, options)
    } finally {
      this.release()
    }
  }

  async probe(pathname: string, options: FfmpegRunOptions = {}): Promise<FfprobeDocument> {
    const signal = options.signal
    await this.acquire(signal)
    try {
      const result = await this.run(this.ffprobePath, [
        '-v', 'error', '-show_streams', '-show_format', '-of', 'json', pathname,
      ], options, true)
      try {
        return JSON.parse(result.stdout) as FfprobeDocument
      } catch (error: unknown) {
        throw new FfmpegError('invalid-probe', `ffprobe returned invalid JSON for ${pathname}`, { cause: error })
      }
    } finally {
      this.release()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const child of this.children) {
      child.kill('SIGKILL')
    }
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.abort !== undefined) waiter.signal.removeEventListener('abort', waiter.abort)
      waiter.reject(new FfmpegError('disposed', 'ffmpeg runner was disposed'))
    }
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

  private run(
    bin: string,
    args: readonly string[],
    options: FfmpegRunOptions,
    probe = false,
  ): Promise<FfmpegRunResult> {
    if (this.disposed) return Promise.reject(new FfmpegError('disposed', 'ffmpeg runner was disposed'))
    if (options.signal?.aborted) return Promise.reject(new FfmpegError('aborted', 'ffmpeg operation was aborted', { cause: options.signal.reason }))
    return new Promise((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(bin, [...args], { cwd: options.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error: unknown) {
        reject(processError(bin, error as NodeJS.ErrnoException))
        return
      }
      this.children.add(child)
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let pending: FfmpegError | undefined
      let settled = false
      const signal = options.signal
      const timeoutMs = options.timeoutMs ?? (probe ? Math.min(this.timeoutMs, 30_000) : this.timeoutMs)
      const timer = setTimeout(() => {
        pending = new FfmpegError('timeout', `${path.basename(bin)} timed out after ${timeoutMs}ms`)
        child.kill('SIGKILL')
      }, timeoutMs)
      timer.unref()
      const onAbort = (): void => {
        pending = new FfmpegError('aborted', 'ffmpeg operation was aborted', { cause: signal?.reason })
        child.kill('SIGKILL')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes = appendTail(stdout, stdoutBytes, chunk) })
      child.stderr?.on('data', (chunk: Buffer) => { stderrBytes = appendTail(stderr, stderrBytes, chunk) })
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.children.delete(child)
        callback()
      }
      child.once('error', (error) => {
        finish(() => { reject(processError(bin, error)) })
      })
      child.once('close', (code, killedBy) => {
        const out = Buffer.concat(stdout).toString('utf8')
        const err = Buffer.concat(stderr).toString('utf8')
        const error = pending
        if (error !== undefined) {
          finish(() => { reject(error) })
          return
        }
        if (code === 0) {
          finish(() => { resolve({ stdout: out, stderr: err }) })
          return
        }
        const tail = err.trim().slice(-ERROR_TAIL_LIMIT)
        finish(() => {
          reject(new FfmpegError('process-exit', `${path.basename(bin)} exited with ${code ?? killedBy}${tail === '' ? '' : `: ${tail}`}`))
        })
      })
    })
  }
}
