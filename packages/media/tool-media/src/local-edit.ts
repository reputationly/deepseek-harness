/** Local FFmpeg edits create immutable candidates through the same scoped canvas writer as generation. */
import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  CanvasNode,
  CanvasNodeId,
  CanvasOperation,
  CanvasService,
  NodeVersion,
  VersionId,
} from '@deepseek-ai/dsh-canvas'
import type { Session } from '@deepseek-ai/dsh-session'
import type { FfmpegRunner, FfprobeDocument } from './ffmpeg.ts'
import { lastVideoFrameIndex } from './ffmpeg.ts'
import type { MediaJob } from './runner.ts'
import type { NodeToolDeps } from './node-tools.ts'
import type { LocalMediaEditFailure, LocalMediaEditRequest, LocalMediaEditResult } from './local-edit-types.ts'
import { localMediaPath } from './local-path.ts'

/** A rejected edit preserves adoption; path identifies completed bytes retained after failure. */
export class LocalMediaEditError extends Error {
  /**
   * @param code - correction or recovery identity.
   * @param message - actionable diagnostic.
   * @param path - completed output retained after interruption, validation, or attachment failure.
   * @param options - original failure.
   */
  constructor(
    readonly code: LocalMediaEditFailure,
    message: string,
    readonly path?: string,
    options?: ErrorOptions,
  ) {
    super(path === undefined ? message : `${message}. File: ${path}`, options)
    this.name = 'LocalMediaEditError'
  }
}

/** Existing managed jobs and FFmpeg own cancellation and subprocess teardown. */
export interface LocalMediaEditorDeps {
  readonly canvas: () => CanvasService
  readonly jobs: NodeToolDeps['jobs']
  readonly ffmpeg: Pick<FfmpegRunner, 'exec' | 'probe'>
  readonly outputDir: string
  readonly report: (error: unknown) => void
}

type AudioRequest = Extract<LocalMediaEditRequest, { operation: 'audio_edit' }>
type AudioSpec = AudioRequest & Required<Pick<AudioRequest, 'inMs' | 'volume' | 'fadeInMs' | 'fadeOutMs'>>
type EditSpec = Exclude<LocalMediaEditRequest, { operation: 'audio_edit' }> | AudioSpec
type LocalOutputVersion = NodeVersion & Required<Pick<NodeVersion, 'path' | 'inputs'>>

function resolveEdit(request: LocalMediaEditRequest): EditSpec {
  return request.operation !== 'audio_edit'
    ? request
    : {
      ...request,
      inMs: request.inMs ?? 0,
      volume: request.volume ?? 1,
      fadeInMs: request.fadeInMs ?? 0,
      fadeOutMs: request.fadeOutMs ?? 0,
    }
}

function seconds(ms: number): string {
  return String(ms / 1000)
}

function durationOf(probe: FfprobeDocument, subject: 'source' | 'output'): number {
  const stream = probe.streams?.find(stream => stream.codec_type === 'audio')
  const seconds = Number(stream?.duration ?? probe.format?.duration)
  if (stream === undefined || !Number.isFinite(seconds) || seconds <= 0)
    throw new LocalMediaEditError(
      subject === 'source' ? 'input' : 'processing',
      `The ${subject} has no readable audio duration`,
    )
  return Math.round(seconds * 1000)
}

function outputMetadata(probe: FfprobeDocument, frame: boolean): Pick<NodeVersion, 'width' | 'height' | 'durationMs'> {
  if (!frame) return { durationMs: durationOf(probe, 'output') }
  const stream = probe.streams?.find(stream => stream.codec_type === 'video')
  const width = stream?.width,
    height = stream?.height
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new LocalMediaEditError('processing', 'The extracted frame has no readable dimensions')
  }
  return { width, height }
}

async function sourceStat(path: string, kind: 'input' | 'source_changed'): Promise<Stats> {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new LocalMediaEditError(kind, `The source is not a regular file: ${path}`)
    return info
  } catch (cause: unknown) {
    if (cause instanceof LocalMediaEditError) throw cause
    throw new LocalMediaEditError(kind, `The source file is unavailable: ${path}`, undefined, { cause })
  }
}

function resolveAudioFilter(request: AudioSpec, duration: number): string {
  const start = request.inMs,
    end = request.outMs ?? duration
  const volume = request.volume,
    fadeIn = request.fadeInMs,
    fadeOut = request.fadeOutMs
  if (
    ![start, end, fadeIn, fadeOut].every(Number.isSafeInteger) ||
    start < 0 ||
    end <= start ||
    end > duration ||
    fadeIn < 0 ||
    fadeOut < 0 ||
    fadeIn > end - start ||
    fadeOut > end - start ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    volume > 4
  ) {
    throw new LocalMediaEditError(
      'input',
      'Choose a nonempty interval inside the source, gain between 0 and 4, and fades no longer than the edited interval',
    )
  }
  return [
    `atrim=start=${seconds(start)}:end=${seconds(end)}`,
    'asetpts=PTS-STARTPTS',
    `volume=${volume}`,
    ...(fadeIn === 0 ? [] : [`afade=t=in:st=0:d=${seconds(fadeIn)}`]),
    ...(fadeOut === 0 ? [] : [`afade=t=out:st=${seconds(end - start - fadeOut)}:d=${seconds(fadeOut)}`]),
  ].join(',')
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** Local edits are idempotent by source version and parameters; interrupted local processing may be explicitly retried. */
export class LocalMediaEditor {
  private readonly live = new Map<string, Promise<LocalMediaEditResult>>()

  /** @param deps - canvas writer, jobs, subprocesses, output directory, and cleanup reporting. */
  constructor(private readonly deps: LocalMediaEditorDeps) {}

  /**
   * Process one exact source and append a candidate without changing any adopted selection.
   * Concurrent identical requests share their managed job. A completed file is reused after an
   * unconfirmed attachment; failed attachment retains the file in LocalMediaEditError.path.
   * Incomplete temporary files are removed on failure; cleanup errors are reported separately.
   * Fully encoded files remain recoverable even when validation, cancellation, or attachment fails.
   * @param session - owner of the project and local job.
   * @param request - captured project, episode, source version, and editing parameters.
   * @param completionNotice - UI callers deliver their own completion and suppress automatic model notices.
   * @returns the attached candidate, or the same retained candidate for a repeated request.
   * @throws LocalMediaEditError for invalid input, changed source, processing, or rejected attachment.
   */
  async edit(
    session: Session,
    request: LocalMediaEditRequest,
    completionNotice?: 'none',
  ): Promise<LocalMediaEditResult> {
    await this.deps.canvas().targetOf(session, request.scope.episode, request.scope.directory)
    const spec = resolveEdit(request)
    const descriptor = JSON.stringify([
      spec.scope.directory,
      spec.scope.episode,
      spec.node,
      spec.version,
      spec.operation,
      spec.operation === 'audio_edit'
        ? [spec.inMs, spec.outMs ?? null, spec.volume, spec.fadeInMs, spec.fadeOutMs]
        : spec.title,
    ])
    const key = createHash('sha256').update(descriptor).digest('hex')
    const running = this.live.get(key)
    if (running !== undefined) return running
    const work = this.start(session, spec, descriptor, completionNotice)
    this.live.set(key, work)
    try {
      return await work
    } finally {
      if (this.live.get(key) === work) this.live.delete(key)
    }
  }

  private async start(
    session: Session,
    request: EditSpec,
    descriptor: string,
    completionNotice?: 'none',
  ): Promise<LocalMediaEditResult> {
    const canvas = this.deps.canvas()
    const target = await canvas.targetOf(session, request.scope.episode, request.scope.directory)
    const read = () => canvas.read(session, target.episode.id, target.directory)
    const initial = await read()
    const sourceNode = initial.nodes.find(node => node.id === request.node)
    const source = sourceNode?.versions?.find(version => version.id === request.version)
    if (sourceNode === undefined || source?.path === undefined)
      throw new LocalMediaEditError('input', 'Choose a retained media version with a local file')
    const sourcePath = source.path
    if (request.operation === 'audio_edit' ? sourceNode.type !== 'audio' : sourceNode.type !== 'video') {
      throw new LocalMediaEditError(
        'input',
        request.operation === 'audio_edit' ? 'Audio editing needs an audio node' : 'This operation needs a video node',
      )
    }
    let previous: { node: CanvasNode; version: NodeVersion } | undefined
    for (const node of initial.nodes) {
      const version = node.versions?.find(version => version.params?.local_edit === descriptor)
      if (version !== undefined) {
        previous = { node, version }
        break
      }
    }
    if (previous !== undefined) {
      const { node: existing, version } = previous
      if (version.path === undefined || version.params?.local_edit !== descriptor)
        throw new LocalMediaEditError('input', 'The saved local edit does not match its request; reread the canvas')
      try {
        await this.cacheTail(session, request, sourceNode, existing.id, version.id)
      } catch (error: unknown) {
        throw new LocalMediaEditError(
          'attachment',
          'The frame is saved; reread the original canvas and retry to refresh its tail cache',
          version.path,
          { cause: error },
        )
      }
      return { node: existing.id, version: version.id, path: version.path, reused: true }
    }
    const input = resolve(target.directory, localMediaPath(source.path))
    const frame = request.operation !== 'audio_edit' && request.operation !== 'extract_audio'
    let attached: LocalMediaEditResult | undefined
    const job: MediaJob = this.deps.jobs(session).start({
      local: true,
      ...(completionNotice === undefined ? {} : { completionNotice }),
      label: request.operation === 'audio_edit' ? sourceNode.title : request.title,
      run: async (signal) => {
        let completedPath: string | undefined
        try {
          const before = await sourceStat(input, 'input')
          // The output name also binds the captured bytes. An orphan from an older source file must
          // never be reused and assigned a newly measured source identity after an interruption.
          const key = createHash('sha256')
            .update(JSON.stringify([descriptor, input, before.size, before.mtimeMs]))
            .digest('hex')
          const id = brandString<VersionId>(`local-${key}`)
          const output = join(resolve(this.deps.outputDir), `local-${key}.${frame ? 'png' : 'wav'}`)
          const probe = await this.deps.ffmpeg.probe(input, {
            signal,
            cwd: target.directory,
            ...(frame && request.operation !== 'first_frame' ? { countVideoFrames: true } : {}),
          })
          const filter =
            request.operation === 'audio_edit' ? resolveAudioFilter(request, durationOf(probe, 'source')) : undefined
          const video = probe.streams?.find(stream => stream.codec_type === 'video')
          if (
            (frame && video === undefined) ||
            (!frame && !probe.streams?.some(stream => stream.codec_type === 'audio'))
          ) {
            throw new LocalMediaEditError(
              'input',
              frame ? 'The source has no video stream' : 'The source has no audio stream',
            )
          }
          const frameIndex = frame ? (request.operation === 'first_frame' ? 0 : lastVideoFrameIndex(probe)) : undefined
          await mkdir(resolve(this.deps.outputDir), { recursive: true })
          if (!(await isFile(output))) {
            const temporary = join(
              resolve(this.deps.outputDir),
              `local-${key}-${randomUUID()}.${frame ? 'png' : 'wav'}`,
            )
            try {
              await this.deps.ffmpeg.exec(
                [
                  '-n',
                  '-i',
                  input,
                  ...(frame
                    ? [
                      '-map',
                      '0:v:0',
                      '-an',
                      '-vf',
                      `select=eq(n\\,${frameIndex})`,
                      '-frames:v',
                      '1',
                      '-fps_mode',
                      'vfr',
                    ]
                    : ['-map', '0:a:0', '-vn', ...(filter === undefined ? [] : ['-af', filter]), '-c:a', 'pcm_s24le']),
                  '-map_metadata',
                  '-1',
                  temporary,
                ],
                { signal, cwd: target.directory },
              )
              completedPath = temporary
              const after = await sourceStat(input, 'source_changed')
              if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
                throw new LocalMediaEditError(
                  'source_changed',
                  'The source file changed during processing; choose its current version and try again',
                )
              if (!(await isFile(output))) await rename(temporary, output)
              completedPath = output
            } finally {
              if (completedPath !== temporary)
                await rm(temporary, { force: true }).catch((error: unknown) => {
                  this.deps.report(error)
                })
            }
          } else {
            completedPath = output
          }
          let metadata: Pick<NodeVersion, 'width' | 'height' | 'durationMs'>
          try {
            metadata = outputMetadata(await this.deps.ffmpeg.probe(output, { signal, cwd: target.directory }), frame)
          } catch (error: unknown) {
            if (!(error instanceof LocalMediaEditError) || error.code !== 'processing') throw error
            const retained = join(
              resolve(this.deps.outputDir),
              `local-${key}-unusable-${randomUUID()}.${frame ? 'png' : 'wav'}`,
            )
            try {
              await rename(output, retained)
            } catch (cause: unknown) {
              throw new LocalMediaEditError(
                'processing',
                'The output is unusable and could not be moved; restore file access before retrying',
                output,
                { cause: new AggregateError([error, cause]) },
              )
            }
            throw new LocalMediaEditError(
              'processing',
              'The output is unusable and retained separately; retry the same edit to render it again',
              retained,
              { cause: error },
            )
          }
          signal.throwIfAborted()
          const version: LocalOutputVersion = {
            id,
            path: output,
            createdAt: new Date().toISOString(),
            origin: 'user',
            ...(request.operation !== 'audio_edit' || source.prompt === undefined ? {} : { prompt: source.prompt }),
            ...(request.operation !== 'audio_edit' || source.model === undefined ? {} : { model: source.model }),
            params: {
              ...(request.operation === 'audio_edit' ? source.params : {}),
              local_edit: descriptor,
              local_source: JSON.stringify({ path: input, size: before.size, mtimeMs: before.mtimeMs }),
            },
            inputs: [{ node: sourceNode.id, version: source.id, path: sourcePath, role: 'source' }],
            ...metadata,
          }
          attached = await this.attach(session, request, sourceNode, source, version, signal)
          return { path: output, model: 'local-ffmpeg' }
        } catch (error: unknown) {
          if (error instanceof LocalMediaEditError) {
            if (error.path !== undefined || completedPath === undefined) throw error
            throw new LocalMediaEditError(error.code, error.message, completedPath, { cause: error })
          }
          throw new LocalMediaEditError(
            'processing',
            error instanceof Error ? error.message : 'Local media processing failed',
            completedPath,
            { cause: error },
          )
        }
      },
    })
    await job.done
    if (attached === undefined) throw new Error('A completed local edit has no attached result')
    return attached
  }

  private async attach(
    session: Session,
    request: EditSpec,
    sourceNode: CanvasNode,
    source: NodeVersion,
    version: LocalOutputVersion,
    signal: AbortSignal,
  ): Promise<LocalMediaEditResult> {
    const canvas = this.deps.canvas()
    try {
      const current = await canvas.read(session, request.scope.episode, request.scope.directory)
      signal.throwIfAborted()
      const node = current.nodes.find(node => node.id === sourceNode.id)
      if (node === undefined)
        throw new LocalMediaEditError(
          'attachment',
          'The source node was removed; the completed file is retained',
          version.path,
        )
      const retained = node.versions?.find(version => version.id === source.id)
      if (retained !== undefined && retained.path !== source.path)
        throw new LocalMediaEditError(
          'source_changed',
          'The source version changed; the completed file is retained',
          version.path,
        )
      const operations: CanvasOperation[] = []
      // A slow local edit can outlive automatic history pruning; its exact captured source remains a candidate.
      if (retained === undefined) operations.push({ op: 'append_version', node: node.id, version: source })
      if (request.operation === 'audio_edit') operations.push({ op: 'append_version', node: node.id, version })
      else
        operations.push(
          {
            op: 'add',
            ref: 'derived',
            type: request.operation === 'extract_audio' ? 'audio' : 'image',
            title: request.title,
            path: version.path,
            inputs: version.inputs,
            initialVersion: version,
            candidate: true,
          },
          { op: 'connect', from: node.id, to: 'derived', kind: 'derivation' },
        )
      const edited = await canvas.edit(session, operations, {
        baseRevision: current.revision,
        episode: request.scope.episode,
        expectedDirectory: request.scope.directory,
        origin: 'user',
        atomic: true,
      })
      if (edited.skipped.length > 0)
        throw new LocalMediaEditError(
          'attachment',
          `The completed file was not fully attached: ${edited.skipped.map(item => item.reason).join('; ')}`,
          version.path,
        )
      const resultNode = request.operation === 'audio_edit' ? node.id : edited.refs.derived
      if (resultNode === undefined) throw new Error('Canvas did not assign the local result node')
      await this.cacheTail(session, request, sourceNode, resultNode, version.id)
      return { node: resultNode, version: version.id, path: version.path, reused: false }
    } catch (error: unknown) {
      if (error instanceof LocalMediaEditError) throw error
      throw new LocalMediaEditError(
        'attachment',
        'The completed file is retained; reread the original canvas and retry the same edit to attach it',
        version.path,
        { cause: error },
      )
    }
  }

  private async cacheTail(
    session: Session,
    request: LocalMediaEditRequest,
    source: CanvasNode,
    frame: CanvasNodeId,
    version: VersionId,
  ): Promise<void> {
    if (request.operation !== 'refresh_tail' || source.activeVersion !== request.version) return
    const canvas = this.deps.canvas()
    const document = await canvas.read(session, request.scope.episode, request.scope.directory)
    const current = document.nodes.find(node => node.id === source.id)
    if (current?.activeVersion !== request.version) return
    const edited = await canvas.edit(
      session,
      [{ op: 'set_tail', node: source.id, tailOf: { node: frame, version, sourceVersion: request.version } }],
      {
        baseRevision: document.revision,
        episode: request.scope.episode,
        expectedDirectory: request.scope.directory,
        origin: 'user',
      },
    )
    if (edited.skipped.length > 0)
      throw new LocalMediaEditError(
        'attachment',
        'The frame is saved; reread the canvas and retry to refresh the tail cache',
      )
  }
}
