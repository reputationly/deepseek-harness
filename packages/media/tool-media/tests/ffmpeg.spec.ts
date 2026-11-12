import { afterEach, describe, expect, it } from 'vitest'
import { FfmpegError, FfmpegRunner } from '../src/ffmpeg.ts'

const runners = new Set<FfmpegRunner>()

function runner(ffmpegPath = process.execPath, ffprobePath = process.execPath, timeoutMs = 5_000): FfmpegRunner {
  const instance = new FfmpegRunner(ffmpegPath, ffprobePath, timeoutMs)
  runners.add(instance)
  return instance
}

afterEach(() => {
  for (const instance of runners) instance.dispose()
  runners.clear()
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

  it('kills active children when disposed and rejects later work', async () => {
    const instance = runner()
    const pending = instance.exec(['-e', 'setTimeout(() => {}, 5000)'])
    await new Promise<void>(resolve => setImmediate(resolve))
    instance.dispose()
    await expect(pending).rejects.toBeInstanceOf(FfmpegError)
    await expect(instance.exec(['-e', 'process.exit(0)'])).rejects.toMatchObject({ code: 'disposed' })
  })
})
