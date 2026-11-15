import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasNodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import { createTimelineCompatibility, type TimelineCompatibility } from '../src/timeline-compatibility.ts'
import type { TimelineRenderAsset } from '../src/timeline-render-types.ts'
import type { FfmpegRunOptions } from '../src/ffmpeg.ts'

let directory: string, asset: TimelineRenderAsset
const providers: TimelineCompatibility[] = []
const recipe = { crf: 18, preset: 'fast', audioBitrate: 192000 }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-compatible-'))
  const path = join(directory, 'source.mp4')
  await writeFile(path, 'original media')
  const info = await stat(path)
  asset = {
    node: brandString<CanvasNodeId>('n1'),
    version: brandString<VersionId>('v1'),
    kind: 'video',
    path,
    size: info.size,
    modifiedMs: info.mtimeMs,
  }
})
afterEach(async () => {
  await Promise.all(providers.splice(0).map(provider => provider.dispose()))
  await rm(directory, { recursive: true, force: true })
})

function fixture() {
  const started: PromiseWithResolvers<void> = Promise.withResolvers(),
    finish: PromiseWithResolvers<void> = Promise.withResolvers()
  const exec = vi.fn(async (args: readonly string[], options: FfmpegRunOptions = {}) => {
    const path = args.at(-1)
    if (path === undefined) throw new Error('missing output path')
    await writeFile(path, 'compatible media')
    started.resolve()
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => {
      aborted.reject(options.signal?.reason)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) onAbort()
    try {
      await Promise.race([finish.promise, aborted.promise])
      return { stdout: '', stderr: '' }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  })
  const provider = createTimelineCompatibility({ exec }, recipe)
  providers.push(provider)
  return { provider, exec, started: started.promise, finish: () => { finish.resolve() } }
}

it('publishes an immutable project copy, reuses it, and leaves the source bytes intact', async () => {
  const job = fixture()
  job.finish()
  const result = await job.provider(asset, directory, new AbortController().signal)
  expect(result.path).toContain(join('.canvas', 'compatible'))
  expect(await readFile(result.path, 'utf8')).toBe('compatible media')
  expect(await readFile(asset.path, 'utf8')).toBe('original media')
  expect(await job.provider(asset, directory, new AbortController().signal)).toEqual(result)
  expect(job.exec).toHaveBeenCalledTimes(1)
})
it('retains a shared conversion when one of its owners cancels', async () => {
  const job = fixture(),
    first = new AbortController(),
    second = new AbortController()
  const one = job.provider(asset, directory, first.signal).catch((error: unknown) => error)
  await job.started
  const listener = vi.spyOn(second.signal, 'addEventListener')
  const two = job.provider(asset, directory, second.signal)
  await vi.waitFor(() => { expect(listener).toHaveBeenCalled() })
  first.abort(new Error('first owner cancelled'))
  job.finish()
  expect(await one).toMatchObject({ message: 'first owner cancelled' })
  expect(await readFile((await two).path, 'utf8')).toBe('compatible media')
  expect(job.exec).toHaveBeenCalledTimes(1)
})
it('cancels and drains its encoder and temporary output when the final owner leaves', async () => {
  const job = fixture(),
    owner = new AbortController()
  const outcome = job.provider(asset, directory, owner.signal).catch((error: unknown) => error)
  await job.started
  owner.abort(new Error('cancelled'))
  expect(await outcome).toMatchObject({ message: 'cancelled' })
  expect(await readdir(join(directory, '.canvas', 'compatible'))).toEqual([])
  expect(await readFile(asset.path, 'utf8')).toBe('original media')
})
it('rejects a source changed during conversion without publishing a copy', async () => {
  const job = fixture(),
    outcome = job.provider(asset, directory, new AbortController().signal).catch((error: unknown) => error)
  await job.started
  await writeFile(asset.path, 'modified source')
  job.finish()
  expect(await outcome).toMatchObject({ message: 'Render source changed during compatibility conversion' })
  expect(await readdir(join(directory, '.canvas', 'compatible'))).toEqual([])
})
it('closes admission and drains an active conversion on disposal', async () => {
  const job = fixture(),
    outcome = job.provider(asset, directory, new AbortController().signal).catch((error: unknown) => error)
  await job.started
  await job.provider.dispose()
  expect(await outcome).toBeInstanceOf(Error)
  await expect(job.provider(asset, directory, new AbortController().signal)).rejects.toThrow('shutting down')
  expect(await readdir(join(directory, '.canvas', 'compatible'))).toEqual([])
})
