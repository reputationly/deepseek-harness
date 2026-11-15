/** Direct outcome and managed-range quiescence are independent completion barriers. */
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { FfmpegRunner } from '../src/ffmpeg.ts'

class Child implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly control = undefined
  readonly collected = {}
  readonly result = Promise.withResolvers<SubprocessOutcome>()
  readonly range = Promise.withResolvers<boolean>()
  readonly done = this.result.promise
  readonly terminate = vi.fn<() => void>()
  readonly waitForExit = vi.fn(() => this.range.promise)
  close(): void {
    this.result.resolve({ exitCode: null, signal: 'SIGKILL' })
    this.range.resolve(true)
  }
}

const children: Child[] = []
const runners = new Set<FfmpegRunner>()
const contexts = new Set<Context>()
const pending = new Set<Promise<unknown>>()

function fixture(count: number, timeoutMs = 600_000) {
  const ready = Promise.withResolvers<undefined>()
  const spawn = vi.fn(() => {
    const child = new Child()
    children.push(child)
    if (children.length === count) ready.resolve(undefined)
    return child
  })
  const runner = new FfmpegRunner({ resolveExecutable: async bin => bin, spawn }, 'ffmpeg', 'ffprobe', timeoutMs)
  runners.add(runner)
  return { runner, ready: ready.promise, spawn }
}

afterEach(async () => {
  for (const child of children) child.close()
  await Promise.allSettled(pending)
  await Promise.all([...runners].map(runner => runner.dispose()))
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  pending.clear()
  runners.clear()
  contexts.clear()
  children.length = 0
})

it('keeps owner disposal pending until active exec/probe and queued calls settle', async () => {
  const f = fixture(2)
  const ctx = new Context()
  contexts.add(ctx)
  ctx.effect(() => () => f.runner.dispose(), 'accepted local processes')
  const calls = [f.runner.exec([]), f.runner.probe('video.mp4'), f.runner.exec([])]
  const results = Promise.allSettled(calls)
  pending.add(results)
  await f.ready
  let stopped = false
  const disposal = ctx.fiber.dispose().then(() => { stopped = true })
  pending.add(disposal)
  // One scheduler turn lets immediate disposal finish; child close remains explicitly blocked.
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(stopped).toBe(false)
  expect(children.every(child => child.terminate.mock.calls.length === 1)).toBe(true)
  await expect(calls[2]).rejects.toMatchObject({ code: 'disposed' })
  await expect(f.runner.exec([])).rejects.toMatchObject({ code: 'disposed' })
  expect(f.runner.dispose()).toBe(f.runner.dispose())
  children[0]?.close()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(stopped).toBe(false)
  children[1]?.close()
  await disposal
  expect((await results).every(result => result.status === 'rejected')).toBe(true)
})

it('retains failed-spawn bookkeeping until the provider joins the failed range', async () => {
  const f = fixture(1)
  const call = f.runner.exec([])
  const result = Promise.allSettled([call])
  pending.add(result)
  await f.ready
  children[0]?.result.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  await new Promise<void>(resolve => setImmediate(resolve))
  let stopped = false
  const disposal = f.runner.dispose().then(() => { stopped = true })
  pending.add(disposal)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(stopped).toBe(false)
  children[0]?.close()
  await expect(call).rejects.toMatchObject({ code: 'binary-not-found' })
  await disposal
})

it('drains calls disposed before acquiring a process without spawning', async () => {
  const f = fixture(1)
  const call = f.runner.exec([])
  const result = Promise.allSettled([call])
  pending.add(result)
  await f.runner.dispose()
  expect(f.spawn).not.toHaveBeenCalled()
  await expect(call).rejects.toMatchObject({ code: 'disposed' })
})

it('retains wrapper ownership after its direct outcome until the descendant range exits', async () => {
  const f = fixture(1)
  let finished = false
  const call = f.runner.exec([])
  pending.add(Promise.allSettled([call]).then(() => { finished = true }))
  await f.ready
  children[0]?.result.resolve({ exitCode: 0, signal: null })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(finished).toBe(false)
  const disposal = f.runner.dispose()
  pending.add(disposal)
  expect(children[0]?.terminate).toHaveBeenCalledOnce()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(finished).toBe(false)
  children[0]?.range.resolve(true)
  await expect(call).rejects.toMatchObject({ code: 'disposed' })
  await disposal
})

it('keeps a timed-out operation pending until both the direct result and range exit', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture(1, 20)
    let finished = false
    const call = f.runner.exec([])
    pending.add(Promise.allSettled([call]).then(() => { finished = true }))
    await f.ready
    await vi.advanceTimersByTimeAsync(20)
    expect(children[0]?.terminate).toHaveBeenCalledOnce()
    expect(finished).toBe(false)
    children[0]?.result.resolve({ exitCode: null, signal: 'SIGKILL' })
    await Promise.resolve()
    expect(finished).toBe(false)
    children[0]?.range.resolve(true)
    await expect(call).rejects.toMatchObject({ code: 'timeout' })
  } finally {
    vi.useRealTimers()
  }
})

it('quarantines an unobservable range and reports failed cleanup instead of claiming quiescence', async () => {
  const f = fixture(1)
  const call = f.runner.exec([])
  pending.add(Promise.allSettled([call]))
  await f.ready
  const cause = new Error('provider lost its range observer')
  children[0]?.result.resolve({ exitCode: 0, signal: null })
  children[0]?.range.reject(cause)
  await expect(call).rejects.toMatchObject({ code: 'cleanup-failed', cause })
  await expect(f.runner.exec([])).rejects.toMatchObject({ code: 'disposed' })
  const disposal = f.runner.dispose()
  pending.add(Promise.allSettled([disposal]))
  await expect(disposal).rejects.toMatchObject({ code: 'cleanup-failed', cause: { errors: [cause] } })
  expect(children[0]?.terminate).toHaveBeenCalledOnce()
  // This fake owns no OS resource. Its declared observation failure is the assertion,
  // so generic successful-drain cleanup must not reinterpret that expected rejection.
  runners.delete(f.runner)
})

it.each(['abort', 'dispose'] as const)('stops a range when provider admission reenters %s before returning its handle', async (stop) => {
  const f = fixture(1)
  const controller = new AbortController()
  const allocate = f.spawn.getMockImplementation()
  if (allocate === undefined) throw new Error('Missing process fixture allocator')
  f.spawn.mockImplementation(() => {
    const child = allocate()
    if (stop === 'abort') controller.abort('cancel during admission')
    else pending.add(f.runner.dispose())
    return child
  })
  const call = f.runner.exec([], { signal: controller.signal })
  pending.add(Promise.allSettled([call]))
  await f.ready
  expect(children[0]?.terminate).toHaveBeenCalledOnce()
  children[0]?.close()
  await expect(call).rejects.toMatchObject({ code: stop === 'abort' ? 'aborted' : 'disposed' })
})
