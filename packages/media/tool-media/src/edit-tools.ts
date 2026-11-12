import { extname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CanvasService } from '@deepseek-ai/dsh-canvas'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { FfprobeDocument, FfmpegRunner } from './ffmpeg.ts'
import {
  checkFfmpegAudioPreserve,
  checkFfmpegCommand,
  checkFfmpegDrawtext,
  injectCjkFont,
  isDryRun,
} from './ffmpeg-guards.ts'
import { placeMediaArtifact } from './visual-tools.ts'

export interface EditToolDeps {
  readonly runner: Pick<FfmpegRunner, 'exec' | 'probe'>
  readonly editTimeoutMs: number
  readonly fontFile?: string
  readonly writePath: (extension: string) => Promise<string>
  readonly canvas: () => CanvasService | undefined
}

type OutputType = 'video' | 'audio' | 'image'
type MediaStream = NonNullable<FfprobeDocument['streams']>[number]
type ProbeResult = {
  readonly path: string
  readonly duration: number
  readonly container: string
  readonly streams: {
    type: string
    codec: string
    width?: number
    height?: number
    frameRate?: string
    sampleRate?: number
    channels?: number
    channelLayout?: string
  }[]
}

function inputPaths(args: readonly string[], projectDir: string): string[] {
  const paths: string[] = []
  let lavfi = false
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === '-f' && args[index + 1] === 'lavfi') lavfi = true
    if (args[index] === '-i') {
      const path = args[index + 1]
      if (!lavfi && path !== undefined) paths.push(resolve(projectDir, path))
      lavfi = false
    }
  }
  return paths
}

function inputNodeIds(ids: readonly string[] | undefined, count: number): string[] {
  if (ids !== undefined && ids.length !== count) throw new Error('input_node_ids must align with the -i inputs; use an empty string for unknown nodes.')
  return ids === undefined ? Array.from({ length: count }, () => '') : [...ids]
}

function outputExtension(type: OutputType, args: readonly string[]): string {
  if (type === 'image') return '.png'
  if (type === 'video') return '.mp4'
  const codec = args.find((_, index) =>
    index > 0 && (args[index - 1] === '-c:a' || args[index - 1] === '-codec:a' || args[index - 1] === '-acodec'))
  const value = codec?.toLowerCase() ?? ''
  if (value.includes('mp3')) return '.mp3'
  if (value.includes('aac')) return '.m4a'
  if (value.includes('flac')) return '.flac'
  if (value.includes('opus')) return '.opus'
  if (value.includes('vorbis')) return '.ogg'
  if (value === 'copy') {
    const input = args.findIndex(arg => arg === '-i')
    if (input === -1) return '.wav'
    return extname(args[input + 1] as string).toLowerCase() || '.wav'
  }
  if (value.includes('pcm')) return '.wav'
  return '.wav'
}

function streamsOf(document: FfprobeDocument): ProbeResult['streams'] {
  return (document.streams ?? []).map((stream: MediaStream) => {
    const sampleRate = stream.sample_rate === undefined ? undefined : Number(stream.sample_rate)
    return {
      type: stream.codec_type ?? 'unknown',
      codec: stream.codec_name ?? 'unknown',
      ...(stream.width === undefined ? {} : { width: stream.width }),
      ...(stream.height === undefined ? {} : { height: stream.height }),
      ...stream.avg_frame_rate === undefined && stream.r_frame_rate === undefined
        ? {}
        : { frameRate: stream.avg_frame_rate ?? stream.r_frame_rate },
      ...(sampleRate === undefined || !Number.isFinite(sampleRate) ? {} : { sampleRate }),
      ...(stream.channels === undefined ? {} : { channels: stream.channels }),
      ...(stream.channel_layout === undefined ? {} : { channelLayout: stream.channel_layout }),
    }
  })
}

function durationOf(document: FfprobeDocument): number {
  const duration = Number(document.format?.duration ?? document.streams?.map(stream => stream.duration).find(Boolean) ?? 0)
  return Number.isFinite(duration) && duration > 0 ? duration : 0
}

function resolution(
  streams: readonly (readonly MediaStream[])[],
  mode: 'first' | 'max' | 'min' | 'custom',
  width?: number,
  height?: number,
): readonly [number, number] {
  if (mode === 'custom') {
    if (width === undefined || height === undefined || width < 2 || height < 2) throw new Error('custom scale_mode requires target_width and target_height of at least 2.')
    return [width, height]
  }
  const dimensions = streams.flatMap((items) => {
    const stream = items.find(item => item.codec_type === 'video')
    return stream?.width !== undefined && stream.height !== undefined ? [[stream.width, stream.height] as const] : []
  })
  if (dimensions.length === 0) throw new Error('merge_videos needs video streams with probeable dimensions.')
  const first = dimensions.reduce(selected => selected)
  if (mode === 'first') return first
  const measure = (size: readonly [number, number]) => size[0] * size[1]
  return dimensions.reduce((selected, candidate) => mode === 'max'
    ? measure(candidate) > measure(selected) ? candidate : selected
    : measure(candidate) < measure(selected) ? candidate : selected)
}

function nodeFrom(
  exec: ToolExecution,
  canvas: CanvasService | undefined,
): { readonly session: Session | undefined; readonly directory: string } {
  const session = exec.agent?.session
  const directory = session === undefined
    ? process.cwd()
    : canvas?.directoryOf(session) ?? session.header.cwd ?? process.cwd()
  return { session, directory }
}

function render(value: Record<string, unknown>) {
  const path = value.path as string
  const node = typeof value.nodeId === 'string' ? ` Canvas node ${value.nodeId}.` : ''
  const canvasError = typeof value.canvasError === 'string' ? ` Canvas placement failed: ${value.canvasError}.` : ''
  if (value.dryRun === true) {
    const summary = typeof value.summary === 'string' ? value.summary : 'Dry run completed.'
    return [{ type: 'text' as const, text: summary }]
  }
  return [{ type: 'text' as const, text: `Wrote ${path}.${node}${canvasError}` }]
}

const artifactSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    path: { type: 'string' as const, required: true as const },
    nodeId: { type: 'string' as const },
    canvasError: { type: 'string' as const },
    dryRun: { type: 'boolean' as const },
    summary: { type: 'string' as const },
  },
}

async function placeOutput(
  deps: EditToolDeps,
  exec: ToolExecution,
  type: 'video' | 'audio' | 'image',
  path: string,
  title: string | undefined,
  sourceNodes: readonly string[],
  sourceFiles: readonly string[],
): Promise<{ readonly nodeId?: string; readonly canvasError?: string }> {
  return placeMediaArtifact(deps.canvas(), exec.agent?.session, {
    type, path, ...(title === undefined ? {} : { title }),
  }, sourceNodes, sourceFiles)
}

function inputCount(args: readonly string[]): number {
  return args.filter(arg => arg === '-i').length
}

function ffmpegDescription(): string {
  return [
    'Edit local media files with FFmpeg. Pass arguments as an array without an output path; -i paths are absolute or relative to the project directory.',
    'The tool chooses the output file and adds it to the project canvas when available. Extracted audio, frames, and clips become new nodes; do not call canvas_edit to add them again.',
    'Use merge_videos for video concatenation. For complex edits, load the media-editing skill first.',
    'Use -f null for a dry run; it creates no file and no canvas node.',
  ].join(' ')
}

export function registerEditTools(ctx: Context, deps: EditToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'ffmpeg',
    description: ffmpegDescription(),
    parameters: {
      args: { type: 'array', required: true, items: { type: 'string' }, description: 'FFmpeg arguments without an output path; include local inputs with -i.' },
      input_node_ids: { type: 'array', items: { type: 'string' }, description: 'Canvas node ids aligned with -i order; use an empty string for an unknown source.' },
      output_type: { type: 'string', enum: ['video', 'audio', 'image'], default: 'video' },
      title: { type: 'string', description: 'Optional title for the result canvas node.' },
    },
    output: {
      schema: artifactSchema,
      render: (_args, value) => render(value),
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      const input = args
      const outputType = input.output_type ?? 'video'
      const checked = checkFfmpegAudioPreserve(input.args, undefined, outputType)
      if (!checked.ok) throw new Error(checked.error)
      const font = injectCjkFont(input.args, deps.fontFile)
      if (!font.ok) throw new Error(font.error)
      const drawtext = checkFfmpegDrawtext(font.args)
      if (!drawtext.ok) throw new Error(drawtext.error)
      const canvas = deps.canvas()
      const { directory } = nodeFrom(exec, canvas)
      const paths = inputPaths(font.args, directory)
      const sources = inputNodeIds(input.input_node_ids, inputCount(font.args))
      const argsWithEncoding = [...font.args]
      if (outputType === 'video' && font.args.some(arg => ['-vf', '-filter_complex', '-filter'].includes(arg))
        && !font.args.some((arg, index) => ['-c:v', '-codec:v', '-vcodec'].includes(arg) && font.args[index + 1] === 'copy')) {
        argsWithEncoding.push('-c:v', 'libx264', '-crf', '18')
      }
      if (isDryRun(argsWithEncoding)) {
        const result = await deps.runner.exec([...argsWithEncoding, '-'], { signal: exec.signal, cwd: directory, timeoutMs: deps.editTimeoutMs })
        return { path: '', dryRun: true, summary: result.stderr.trim().slice(-2_000) || result.stdout.trim().slice(-2_000) || 'Dry run completed.' }
      }
      const path = await deps.writePath(outputExtension(outputType, argsWithEncoding))
      await deps.runner.exec(['-y', ...argsWithEncoding, path], { signal: exec.signal, cwd: directory, timeoutMs: deps.editTimeoutMs })
      const placement = await placeOutput(deps, exec, outputType, path, input.title, sources, paths)
      return { path, ...placement }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'merge_videos',
    description: 'Join two or more local video files in order. Streams are probed, normalized to a shared resolution and frame rate, and missing or short audio is padded with silence. Complex edits should load the media-editing skill.',
    parameters: {
      video_paths: { type: 'array', required: true, items: { type: 'string' } },
      input_node_ids: { type: 'array', items: { type: 'string' }, description: 'Canvas node ids aligned with video_paths; use an empty string for an unknown source.' },
      scale_mode: { type: 'string', enum: ['first', 'max', 'min', 'custom'], default: 'first' },
      target_width: { type: 'integer' },
      target_height: { type: 'integer' },
    },
    output: { schema: artifactSchema, render: (_args, value) => render(value), presentationMeta: (_args, value) => value },
    async execute(args, exec) {
      const input = args
      if (input.video_paths.length < 2) throw new Error('merge_videos needs at least two video_paths.')
      const command = checkFfmpegCommand(input.video_paths.flatMap(file => ['-i', file]))
      if (!command.ok) throw new Error(command.error)
      const canvas = deps.canvas()
      const { directory } = nodeFrom(exec, canvas)
      const paths = input.video_paths.map(file => resolve(directory, file))
      const sources = inputNodeIds(input.input_node_ids, paths.length)
      const probes = await Promise.all(paths.map(file => deps.runner.probe(file, {
        signal: exec.signal,
        cwd: directory,
        timeoutMs: deps.editTimeoutMs,
      })))
      const streams = probes.map(probe => probe.streams ?? [])
      if (streams.some(items => !items.some(stream => stream.codec_type === 'video'))) {
        throw new Error('merge_videos requires each input to contain a video stream.')
      }
      const size = resolution(streams, input.scale_mode ?? 'first', input.target_width, input.target_height)
      const durations = probes.map(durationOf)
      const ffmpegArgs: string[] = []
      paths.forEach(file => ffmpegArgs.push('-i', file))
      const silenceInputs = new Map<number, number>()
      let silenceCount = 0
      streams.forEach((items, index) => {
        if (!items.some(stream => stream.codec_type === 'audio')) {
          silenceInputs.set(index, paths.length + silenceCount)
          silenceCount++
          ffmpegArgs.push('-f', 'lavfi', '-t', String(durations[index] || 1), '-i', 'anullsrc=r=48000:cl=stereo')
        }
      })
      const filters: string[] = []
      for (const [index] of probes.entries()) {
        filters.push(`[${index}:v]scale=${size[0]}:${size[1]}:force_original_aspect_ratio=decrease,pad=${size[0]}:${size[1]}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,setpts=PTS-STARTPTS[v${index}]`)
        const duration = Math.max(0.1, durations[index] || 0.1)
        const audio = silenceInputs.get(index) ?? index
        filters.push(`[${audio}:a]apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`)
      }
      filters.push(`${probes.map((_, index) => `[v${index}][a${index}]`).join('')}concat=n=${paths.length}:v=1:a=1[outv][outa]`)
      const output = await deps.writePath('.mp4')
      ffmpegArgs.push('-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', '-y', output)
      await deps.runner.exec(ffmpegArgs, { signal: exec.signal, cwd: directory, timeoutMs: deps.editTimeoutMs })
      const placement = await placeOutput(deps, exec, 'video', output, undefined, sources, paths)
      return { path: output, ...placement }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'media_probe',
    description: 'Probe a local media file or canvas media node before editing. Returns duration, container, and stream codecs and dimensions/audio properties.',
    parameters: {
      path: { type: 'string', description: 'Absolute path or path relative to the project directory.' },
      node_id: { type: 'string', description: 'Canvas image, video, or audio node id.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true }, duration: { type: 'number', required: true },
          container: { type: 'string', required: true },
          streams: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                type: { type: 'string', required: true }, codec: { type: 'string', required: true },
                width: { type: 'number' }, height: { type: 'number' }, frameRate: { type: 'string' },
                sampleRate: { type: 'number' }, channels: { type: 'number' }, channelLayout: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.path}: ${value.duration}s, ${value.container}; ${value.streams.length} stream(s).` }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      const input = args
      if ((input.path === undefined) === (input.node_id === undefined)) throw new Error('Pass exactly one of path or node_id.')
      const canvas = deps.canvas()
      const { directory, session } = nodeFrom(exec, canvas)
      let path = input.path === undefined ? '' : resolve(directory, input.path)
      if (input.node_id !== undefined) {
        if (canvas === undefined || session === undefined) throw new Error('media_probe needs a canvas session to resolve node_id; pass path instead.')
        try {
          const resolved = await canvas.resolveMedia(session, [input.node_id])
          const resolvedPath = resolved[0]
          if (resolvedPath === undefined) throw new Error(`canvas node ${input.node_id} did not resolve to a media path.`)
          path = resolvedPath
        } catch (error: unknown) {
          throw new Error(`media_probe: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
      const command = checkFfmpegCommand(['-i', path])
      if (!command.ok) throw new Error(command.error)
      const probe = await deps.runner.probe(path, { signal: exec.signal, cwd: directory, timeoutMs: deps.editTimeoutMs })
      const result: ProbeResult = {
        path,
        duration: durationOf(probe),
        container: probe.format?.format_name ?? 'unknown',
        streams: streamsOf(probe),
      }
      return result
    },
  }))
}
