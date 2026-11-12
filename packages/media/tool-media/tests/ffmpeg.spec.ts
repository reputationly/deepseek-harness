import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FfmpegError, FfmpegRunner } from '../src/ffmpeg.ts'

const runners = new Set<FfmpegRunner>()
const directories = new Set<string>()

function runner(ffmpegPath = process.execPath, ffprobePath = process.execPath, timeoutMs = 5_000): FfmpegRunner {
  const instance = new FfmpegRunner(ffmpegPath, ffprobePath, timeoutMs)
  runners.add(instance)
  return instance
}

afterEach(async () => {
  for (const instance of runners) instance.dispose()
  runners.clear()
  await Promise.all([...directories].map(directory => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

describe('FfmpegRunner', () => {
  it('runs a process without a shell and captures bounded stdout and stderr', async () => {
    const result = await runner().exec(['-e', "process.stdout.write('ready'); process.stderr.write('note')"])
    expect(result).toEqual({ stdout: 'ready', stderr: 'note' })
  })

  it('includes only the tail of stderr for non-zero exits', async () => {
    let error: unknown
    try {
      await runner().exec(['-e', "process.stderr.write('x'.repeat(4000)); process.exit(7)"])
    } catch (caught: unknown) {
      error = caught
    }
    if (!(error instanceof FfmpegError)) throw new Error('Expected a typed FFmpeg process error.')
    expect(error.code).toBe('process-exit')
    expect(error.message.endsWith('x'.repeat(2_000))).toBe(true)
  })

  it('kills timed-out and aborted children with typed errors', async () => {
    await expect(runner(process.execPath, process.execPath, 25).exec(['-e', 'setTimeout(() => {}, 5000)']))
      .rejects.toMatchObject({ code: 'timeout' })
    const controller = new AbortController()
    const pending = runner().exec(['-e', 'setTimeout(() => {}, 5000)'], { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(100)]) })
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    controller.abort()
  })

  it('reports a missing ffmpeg executable with the configured-path hint', async () => {
    await expect(runner('/no/such/ffmpeg').exec([])).rejects.toMatchObject({
      code: 'binary-not-found',
      message: '未找到 ffmpeg，请安装或配置 ffmpegPath',
    })
  })

  it('reports missing ffprobe and invalid probe JSON with typed errors', async () => {
    await expect(runner(process.execPath, '/no/such/ffprobe').probe('input.mp4')).rejects.toMatchObject({
      code: 'binary-not-found',
      message: '未找到 ffprobe，请安装或配置 ffprobePath',
    })
    await expect(runner(process.execPath, process.execPath).probe('input.mp4')).rejects.toMatchObject({
      code: 'invalid-probe',
      message: 'ffprobe returned invalid JSON for input.mp4',
    })
  })

  it('bounds stdout while retaining its newest bytes', async () => {
    const result = await runner().exec([
      '-e',
      "process.stdout.write('a'.repeat(1_000_000)); setTimeout(() => process.stdout.write('b'.repeat(5_000_000)), 10)",
    ])
    expect(result.stdout).toHaveLength(4 * 1024 * 1024)
    expect(result.stdout.endsWith('b'.repeat(100))).toBe(true)
  })

  it('maps non-ENOENT spawn failures to process-exit errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ffmpeg-directory-'))
    directories.add(directory)
    await expect(runner(directory).exec([])).rejects.toMatchObject({
      code: 'process-exit',
      message: /could not start/u,
    })
    await expect(runner().exec(['\u0000'])).rejects.toMatchObject({
      code: 'process-exit',
      message: /could not start/u,
    })
  })

  it('kills active children when disposed and rejects later work', async () => {
    const instance = runner()
    const pending = instance.exec(['-e', 'setTimeout(() => {}, 5000)'])
    await new Promise<void>(resolve => setImmediate(resolve))
    instance.dispose()
    await expect(pending).rejects.toBeInstanceOf(FfmpegError)
    await expect(instance.exec(['-e', 'process.exit(0)'])).rejects.toMatchObject({ code: 'disposed' })
  })

  it('rejects pre-aborted, newly aborted, and disposed-before-spawn work', async () => {
    const instance = runner()
    const preAborted = new AbortController()
    preAborted.abort('already stopped')
    await expect(instance.exec([], { signal: preAborted.signal })).rejects.toMatchObject({ code: 'aborted' })

    const abortBeforeSpawn = new AbortController()
    const aborted = instance.exec([], { signal: abortBeforeSpawn.signal })
    abortBeforeSpawn.abort('stopped before spawn')
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' })

    const disposed = runner()
    const neverSpawned = disposed.exec([])
    disposed.dispose()
    await expect(neverSpawned).rejects.toMatchObject({ code: 'disposed' })
  })

  it('releases queued jobs in order and removes aborted waiters', async () => {
    const instance = runner()
    const code = 'setTimeout(() => process.stdout.write("done"), 60)'
    const first = instance.exec(['-e', code])
    const second = instance.exec(['-e', code])
    const third = instance.exec(['-e', code])
    const fourthController = new AbortController()
    const fourth = instance.exec(['-e', code], { signal: fourthController.signal })
    await expect(Promise.all([first, second, third, fourth])).resolves.toEqual([
      { stdout: 'done', stderr: '' },
      { stdout: 'done', stderr: '' },
      { stdout: 'done', stderr: '' },
      { stdout: 'done', stderr: '' },
    ])

    const activeOne = instance.exec(['-e', 'setTimeout(() => {}, 5000)'])
    const activeTwo = instance.exec(['-e', 'setTimeout(() => {}, 5000)'])
    const controller = new AbortController()
    const waiting = instance.exec(['-e', 'process.exit(0)'], { signal: controller.signal })
    await new Promise<void>(resolve => setImmediate(resolve))
    controller.abort('cancel queued work')
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
    instance.dispose()
    await expect(Promise.all([activeOne, activeTwo])).rejects.toBeInstanceOf(FfmpegError)
  })

  it('rejects queued waiters when the runner is disposed', async () => {
    const instance = runner()
    const first = instance.exec(['-e', 'setTimeout(() => {}, 5000)'])
    const second = instance.exec(['-e', 'setTimeout(() => {}, 5000)'])
    const waiting = instance.exec(['-e', 'process.exit(0)'])
    await new Promise<void>(resolve => setImmediate(resolve))
    instance.dispose()
    await expect(waiting).rejects.toMatchObject({ code: 'disposed' })
    await expect(Promise.all([first, second])).rejects.toBeInstanceOf(FfmpegError)
  })

  it('removes abort listeners when disposing queued waiters', async () => {
    const instance = runner()
    const first = instance.exec(['-e', 'setTimeout(() => {}, 5000)'])
    const second = instance.exec(['-e', 'setTimeout(() => {}, 5000)'])
    const controller = new AbortController()
    const waiting = instance.exec(['-e', 'process.exit(0)'], { signal: controller.signal })
    await new Promise<void>(resolve => setImmediate(resolve))
    instance.dispose()
    await expect(waiting).rejects.toMatchObject({ code: 'disposed' })
    controller.abort('disposed')
    await expect(Promise.all([first, second])).rejects.toBeInstanceOf(FfmpegError)
  })
})
