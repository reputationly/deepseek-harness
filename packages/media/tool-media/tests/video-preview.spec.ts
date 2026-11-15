/** Preview caches must not publish partial files or accept sources outside their project/media roots. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createVideoPreview } from '../src/video-preview.ts'

const directories = new Set<string>()
afterEach(async () => { await Promise.all([...directories].map(root => rm(root, { recursive: true, force: true }))); directories.clear() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-preview-'))
  directories.add(root)
  const project = join(root, '项目 with spaces'), output = join(root, 'generated')
  await Promise.all([mkdir(project), mkdir(output)])
  const source = join(project, 'original.mp4')
  await writeFile(source, 'original')
  const exec = vi.fn(async (args: readonly string[]) => {
    await writeFile(args.at(-1)!, 'complete webm')
    return { stdout: '', stderr: '' }
  })
  return { root, project, output, source, exec }
}

it('deduplicates concurrent encodes, caches completed files, and leaves the original intact', async () => {
  const f = await fixture()
  const preview = createVideoPreview({ exec: f.exec }, f.output)
  const [first, second] = await Promise.all([preview(f.source, f.project), preview(f.source, f.project)])
  expect(first).toBe(second)
  expect(f.exec).toHaveBeenCalledTimes(1)
  expect(await readFile(first, 'utf8')).toBe('complete webm')
  expect(await readFile(f.source, 'utf8')).toBe('original')
  expect(await preview(f.source, f.project)).toBe(first)
  expect(f.exec).toHaveBeenCalledTimes(1)
  await writeFile(f.source, 'replaced source with different bytes')
  expect(await preview(f.source, f.project)).not.toBe(first)
  expect(f.exec).toHaveBeenCalledTimes(2)
})

it('removes partial output after an encoder error and allows a subsequent retry', async () => {
  const f = await fixture()
  f.exec.mockImplementationOnce(async (args) => { await writeFile(args.at(-1)!, 'partial'); throw new Error('encoder failed') })
  const preview = createVideoPreview({ exec: f.exec }, f.output)
  await expect(preview(f.source, f.project)).rejects.toThrow('encoder failed')
  expect(await readdir(join(f.project, '.canvas', 'previews'))).toEqual([])
  expect(await readFile(await preview(f.source, f.project), 'utf8')).toBe('complete webm')
})

it('rejects foreign sources and accepts the configured media output directory', async () => {
  const f = await fixture()
  const foreign = join(f.root, 'foreign.mp4'), generated = join(f.output, 'generated.mp4')
  await Promise.all([writeFile(foreign, 'foreign'), writeFile(generated, 'generated')])
  const preview = createVideoPreview({ exec: f.exec }, f.output)
  await expect(preview(foreign, f.project)).rejects.toThrow('Import this video')
  expect(f.exec).not.toHaveBeenCalled()
  await expect(preview(generated, f.project)).resolves.toMatch(/\.webm$/u)
  await expect(preview('original.mp4', f.project)).resolves.toMatch(/\.webm$/u)
})

it('closes admission and awaits an accepted encoder failure and its temporary-file cleanup', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const finish = Promise.withResolvers<undefined>()
  f.exec.mockImplementationOnce(async (args) => {
    await writeFile(args.at(-1)!, 'partial')
    entered.resolve(undefined)
    await finish.promise
    throw new Error('encoder stopped')
  })
  const preview = createVideoPreview({ exec: f.exec }, f.output)
  const work = preview(f.source, f.project)
  const observed = Promise.allSettled([work])
  let disposal: Promise<void> | undefined
  try {
    await entered.promise
    let stopped = false
    disposal = preview.dispose().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    await expect(preview(f.source, f.project)).rejects.toMatchObject({ code: 'disposed' })
    expect(preview.dispose()).toBe(preview.dispose())
    finish.resolve(undefined)
    await expect(work).rejects.toThrow('encoder stopped')
    await disposal
    expect(await readdir(join(f.project, '.canvas', 'previews'))).toEqual([])
  } finally {
    finish.resolve(undefined)
    await observed
    await disposal
  }
})
