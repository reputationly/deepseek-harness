/** Full-resolution local compatibility copies; generated media and pinned versions are never overwritten. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { FfmpegRunner } from './ffmpeg.ts'
import type { TimelineRenderAsset } from './timeline-render-types.ts'

/**
 * The dimensions and codec identity used to prepare compatible timeline inputs.
 */
export interface TimelineCompatibilityRecipe {
  readonly crf: number
  readonly preset: string
  readonly audioBitrate: number
}
/**
 * The Host port that prepares a pinned source for browser decoding.
 */
export interface TimelineCompatibility {
  (asset: TimelineRenderAsset, directory: string, signal: AbortSignal): Promise<TimelineRenderAsset>
  dispose(): Promise<void>
}

/**
 * Create a managed compatibility provider; every accepted request drains its encoder and temporary file.
 * @param runner - Configured FFmpeg process runner.
 * @param recipe - Codec and dimensions defining compatible output.
 * @returns A converter that reuses validated compatible files.
 */
export function createTimelineCompatibility(
  runner: Pick<FfmpegRunner, 'exec'>,
  recipe: TimelineCompatibilityRecipe,
): TimelineCompatibility {
  const active = new Map<
    string,
    { readonly controller: AbortController; readonly done: Promise<string>; readonly owners: Set<symbol> }
  >()
  const requests = new Set<Promise<TimelineRenderAsset>>()
  let disposal: Promise<void> | undefined
  const prepare = async (
    asset: TimelineRenderAsset,
    project: string,
    signal: AbortSignal,
  ): Promise<TimelineRenderAsset> => {
    signal.throwIfAborted()
    if (asset.kind === 'image') throw new Error('Import this image as PNG, JPEG or WebP before rendering')
    const path = await realpath(asset.path),
      before = await stat(path)
    if (before.size !== asset.size || before.mtimeMs !== asset.modifiedMs)
      throw new Error('Render source changed before compatibility conversion')
    const root = await realpath(project),
      directory = join(root, '.canvas', 'compatible')
    await mkdir(directory, { recursive: true })
    const canonical = await realpath(directory),
      within = relative(root, canonical)
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error('Compatibility cache must stay inside the project')
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          version: 1,
          path,
          size: before.size,
          mtime: before.mtimeMs,
          ctime: before.ctimeMs,
          kind: asset.kind,
          recipe,
        }),
      )
      .digest('hex')
    const target = join(canonical, `${key}.mp4`)
    let existing = await stat(target).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (existing === undefined || existing.size === 0) {
      signal.throwIfAborted()
      if (disposal !== undefined) throw new Error('Compatibility conversion is shutting down')
      let work = active.get(target)
      if (work === undefined) {
        const controller = new AbortController(),
          owners = new Set<symbol>()
        const done = (async () => {
          const temporary = join(canonical, `${key}.${randomUUID()}.mp4`)
          try {
            await runner.exec(
              [
                '-nostdin',
                '-y',
                '-i',
                path,
                ...(asset.kind === 'video'
                  ? [
                    '-map',
                    '0:v:0',
                    '-map',
                    '0:a?',
                    '-c:v',
                    'libx264',
                    '-preset',
                    recipe.preset,
                    '-crf',
                    String(recipe.crf),
                    '-pix_fmt',
                    'yuv420p',
                  ]
                  : ['-map', '0:a:0', '-vn']),
                '-c:a',
                'aac',
                '-b:a',
                String(recipe.audioBitrate),
                '-ac',
                '2',
                '-ar',
                '48000',
                '-movflags',
                '+faststart',
                '-f',
                'mp4',
                temporary,
              ],
              { signal: controller.signal },
            )
            const after = await stat(path),
              output = await stat(temporary)
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
              throw new Error('Render source changed during compatibility conversion')
            if (output.size === 0) throw new Error('Compatibility encoder produced an empty file')
            controller.signal.throwIfAborted()
            await rename(temporary, target)
            return target
          } finally {
            await rm(temporary, { force: true })
          }
        })()
        work = { controller, done, owners }
        active.set(target, work)
        const finish = (): void => {
          if (active.get(target)?.done === done) active.delete(target)
        }
        void done.then(finish, finish)
      }
      const owner = Symbol('render-source')
      work.owners.add(owner)
      const aborted = Promise.withResolvers<never>()
      const onAbort = (): void => {
        work.owners.delete(owner)
        if (work.owners.size === 0) work.controller.abort(signal.reason)
        aborted.reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      try {
        await Promise.race([work.done, aborted.promise])
      } finally {
        signal.removeEventListener('abort', onAbort)
        work.owners.delete(owner)
        if (work.owners.size === 0) {
          work.controller.abort()
          // Preserve the outcome above while waiting for the final owner to release the encoder and temporary file.
          await Promise.allSettled([work.done])
        }
      }
      existing = await stat(target)
    }
    signal.throwIfAborted()
    return { ...asset, path: target, size: existing.size, modifiedMs: existing.mtimeMs }
  }
  return Object.assign(
    (asset: TimelineRenderAsset, directory: string, signal: AbortSignal): Promise<TimelineRenderAsset> => {
      if (disposal !== undefined) return Promise.reject(new Error('Compatibility conversion is shutting down'))
      const pending = prepare(asset, directory, signal)
      requests.add(pending)
      const finished = (): void => {
        requests.delete(pending)
      }
      void pending.then(finished, finished)
      return pending
    },
    {
      dispose: (): Promise<void> => {
        if (disposal === undefined) {
          for (const work of active.values()) work.controller.abort()
          disposal = Promise.allSettled(requests).then(() => undefined)
        }
        return disposal
      },
    },
  )
}
