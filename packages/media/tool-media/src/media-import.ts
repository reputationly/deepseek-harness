/** Verified upload streams become immutable media candidates through the scoped canvas writer. */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasService, NodeVersion, VersionId } from '@deepseek-ai/dsh-canvas'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FfmpegRunner } from './ffmpeg.ts'
import { LocalMediaEditError } from './local-edit.ts'
import type { LocalMediaEditResult, LocalMediaImportRequest } from './local-edit-types.ts'
import type { NodeToolDeps } from './node-tools.ts'

/** The upload owner verifies the stream before its iteration completes. */
export interface MediaUploadSource {
  readonly key: string
  readonly name: string
  /**
   * @param signal - cancels verification and reading before project publication.
   * @returns bounded verified chunks; integrity failures reject the iteration.
   */
  readonly data: (signal: AbortSignal) => AsyncIterable<Uint8Array>
}

interface Deps {
  readonly canvas: () => CanvasService
  readonly jobs: NodeToolDeps['jobs']
  readonly ffmpeg: Pick<FfmpegRunner, 'probe'>
  readonly report: (error: unknown) => void
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** Imports copy verified bytes into the project; adoption remains an explicit canvas operation. */
export class LocalMediaImporter {
  private readonly live = new Map<string, Promise<LocalMediaEditResult>>()

  /** @param deps - scoped writer, local jobs, media probe, and cleanup reporting. */
  constructor(private readonly deps: Deps) {}

  /**
   * Import into an existing media node without replacing its adopted version. Identical uploads share
   * work and a candidate; complete files survive failed probing, cancellation, and failed attachment.
   * @param session - exact receiving Session selected by the upload owner.
   * @param request - captured project, episode, destination node, and upload receipt.
   * @param source - verified upload capability resolved for this Session.
   * @param kind - expected destination and required probe stream; defaults to video.
   * @returns the saved candidate and retained project file.
   */
  async import(
    session: Session,
    request: LocalMediaImportRequest,
    source: MediaUploadSource,
    kind: 'video' | 'audio' = 'video',
  ): Promise<LocalMediaEditResult> {
    await this.deps.canvas().targetOf(session, request.scope.episode, request.scope.directory)
    const identity = [request.scope.directory, request.scope.episode, request.node, source.key, source.name]
    if (kind === 'audio') identity.push(kind)
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
    const pending = this.live.get(key)
    if (pending !== undefined) return pending
    const work = this.start(session, request, source, key, kind)
    this.live.set(key, work)
    try {
      return await work
    } finally {
      if (this.live.get(key) === work) this.live.delete(key)
    }
  }

  private async start(
    session: Session,
    request: LocalMediaImportRequest,
    source: MediaUploadSource,
    key: string,
    kind: 'video' | 'audio',
  ): Promise<LocalMediaEditResult> {
    const canvas = this.deps.canvas()
    const current = await canvas.read(session, request.scope.episode, request.scope.directory)
    const destination = current.nodes.find(node => node.id === request.node)
    if (destination?.type !== kind)
      throw new LocalMediaEditError('input', `Choose an existing ${kind} node for the upload`)
    const id = brandString<VersionId>(`v_import_${key.slice(0, 24)}`)
    const saved = destination.versions?.find(version => version.id === id)
    if (saved?.path !== undefined) return { node: request.node, version: id, path: saved.path, reused: true }
    const output = join(request.scope.directory, '.canvas', 'imports', `${key}${extname(source.name)}`)
    let completed: string | undefined
    let result: LocalMediaEditResult | undefined
    const job = this.deps.jobs(session).start({
      label: destination.title,
      local: true,
      completionNotice: 'none',
      run: async (signal) => {
        await mkdir(join(request.scope.directory, '.canvas', 'imports'), { recursive: true })
        const temporary = `${output}.${randomUUID()}.part`
        let reused = await exists(output)
        if (!reused) {
          try {
            await pipeline(Readable.from(source.data(signal)), createWriteStream(temporary, { flags: 'wx' }), {
              signal,
            })
            completed = temporary
            await rename(temporary, output)
          } finally {
            if (completed !== temporary)
              await rm(temporary, { force: true }).catch((error: unknown) => {
                this.deps.report(error)
              })
          }
        }
        completed = output
        const probe = await this.deps.ffmpeg.probe(output, { signal, cwd: request.scope.directory })
        const stream = probe.streams?.find(stream => stream.codec_type === kind)
        const durationMs = Math.round(Number(stream?.duration ?? probe.format?.duration) * 1000)
        if (stream === undefined || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
          throw new LocalMediaEditError(
            'input',
            `The uploaded file has no ${kind} stream with a measurable duration`,
            output,
          )
        }
        let dimensions: Pick<NodeVersion, 'width' | 'height'> = {}
        if (kind === 'video') {
          const width = stream.width,
            height = stream.height
          if (
            width === undefined ||
            height === undefined ||
            !Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width <= 0 ||
            height <= 0
          ) {
            throw new LocalMediaEditError('input', 'The uploaded video has no readable dimensions', output)
          }
          dimensions = { width, height }
        }
        signal.throwIfAborted()
        try {
          const latest = await canvas.read(session, request.scope.episode, request.scope.directory)
          const node = latest.nodes.find(node => node.id === request.node)
          if (node?.type !== kind)
            throw new LocalMediaEditError('source_changed', 'The destination media node was removed or changed', output)
          if (node.versions?.some(version => version.id === id)) reused = true
          else {
            if (signal.aborted)
              throw new LocalMediaEditError(
                'processing',
                'The import was cancelled before attachment; the media file is retained',
                output,
                { cause: signal.reason },
              )
            const version: NodeVersion = {
              id,
              path: output,
              createdAt: new Date().toISOString(),
              origin: 'user',
              ...dimensions,
              durationMs,
              params: { upload_source: source.key, upload_name: source.name },
            }
            await canvas.edit(session, [{ op: 'append_version', node: request.node, version }], {
              episode: request.scope.episode,
              expectedDirectory: request.scope.directory,
              baseRevision: latest.revision,
              origin: 'user',
              atomic: true,
            })
          }
        } catch (cause: unknown) {
          if (cause instanceof LocalMediaEditError) throw cause
          throw new LocalMediaEditError(
            'attachment',
            'The uploaded file is retained; reopen the original project and retry the import',
            output,
            { cause },
          )
        }
        result = { node: request.node, version: id, path: output, reused }
        return { path: output, kind, model: 'local-import' }
      },
    })
    try {
      await job.done
      if (result === undefined)
        throw new LocalMediaEditError('processing', 'The media import did not acknowledge a candidate', completed)
      return result
    } catch (cause: unknown) {
      if (cause instanceof LocalMediaEditError) throw cause
      throw new LocalMediaEditError(
        'processing',
        'The media import failed; any completed file is retained',
        completed,
        { cause },
      )
    }
  }
}
