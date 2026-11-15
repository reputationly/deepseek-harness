/** Local WebM previews preserve the generated original and need no cloud request. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { FfmpegError, type FfmpegRunner } from './ffmpeg.ts'
import { localMediaPath } from './local-path.ts'

function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

async function exists(path: string): Promise<boolean> {
  try { const file = await stat(path); return file.isFile() && file.size > 0 }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

/** A preview encoder whose owner can close admission and await file cleanup. */
export interface VideoPreview {
  /** Prepare a compatible preview.
   * @param source - project-local or generated video path.
   * @param project - project directory whose preview cache receives the result.
   * @returns the complete cached WebM path.
   */
  (source: string, project: string): Promise<string>
  /** Stop new requests and await all accepted reads, encodes, and cleanup.
   * @returns the same drain promise for repeated disposal requests.
   */
  dispose(): Promise<void>
}

/**
 * Deduplicate concurrent decodes and publish only complete, nonempty previews.
 * @param runner - local FFmpeg process owner.
 * @param outputRoot - configured directory of generated media allowed as preview input.
 * @returns a project-scoped video preview encoder with an atomic disk cache.
 */
export function createVideoPreview(runner: Pick<FfmpegRunner, 'exec'>, outputRoot: string): VideoPreview {
  const active = new Map<string, Promise<string>>()
  const requests = new Set<Promise<string>>()
  let disposal: Promise<void> | undefined
  const encode = async (source: string, project: string): Promise<string> => {
    const path = await realpath(resolve(project, localMediaPath(source)))
    const root = await realpath(project)
    const mediaRoot = await realpath(outputRoot).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (!inside(root, path) && (mediaRoot === undefined || !inside(mediaRoot, path))) {
      throw new Error('Import this video into the project before preparing its preview')
    }
    const file = await stat(path, { bigint: true })
    if (!file.isFile()) throw new Error('Video source is not a file')
    const key = createHash('sha256').update([path, file.size, file.mtimeNs, file.ctimeNs].join(':')).digest('hex')
    const directory = join(root, '.canvas', 'previews')
    await mkdir(directory, { recursive: true })
    const canonical = await realpath(directory)
    if (!inside(root, canonical)) throw new Error('Preview cache must stay inside the project')
    const target = join(canonical, `${key}.webm`)
    if (await exists(target)) return target
    const previous = active.get(target)
    if (previous !== undefined) return previous
    const pending = (async () => {
      const temporary = join(canonical, `${key}.${randomUUID()}.webm`)
      try {
        await runner.exec([
          '-nostdin', '-y', '-i', path, '-map', '0:v:0', '-map', '0:a?',
          '-vf', 'scale=w=min(1280\\,iw):h=min(1280\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1',
          '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '32', '-b:v', '0',
          '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '96k', '-f', 'webm', temporary,
        ])
        if (!await exists(temporary)) throw new Error('Preview encoder produced no video')
        await rename(temporary, target)
        return target
      } finally {
        await rm(temporary, { force: true })
      }
    })()
    active.set(target, pending)
    try { return await pending }
    finally { if (active.get(target) === pending) active.delete(target) }
  }
  return Object.assign((source: string, project: string): Promise<string> => {
    if (disposal !== undefined) return Promise.reject(new FfmpegError('disposed', 'video previews are stopping'))
    const pending = encode(source, project)
    requests.add(pending)
    const finish = (): void => { requests.delete(pending) }
    void pending.then(finish, finish)
    return pending
  }, {
    dispose: (): Promise<void> => { disposal ??= Promise.allSettled(requests).then(() => {}); return disposal },
  })
}
