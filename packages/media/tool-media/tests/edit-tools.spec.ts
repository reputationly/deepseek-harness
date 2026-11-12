import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CanvasService from '@deepseek-ai/dsh-canvas'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerEditTools } from '../src/edit-tools.ts'
import type { FfprobeDocument, FfmpegRunOptions, FfmpegRunResult, FfmpegRunner } from '../src/ffmpeg.ts'

let directory: string
let ctx: Context
let session: Session
let runCalls: { readonly args: readonly string[]; readonly options?: FfmpegRunOptions }[]
let probes: Map<string, FfprobeDocument>
let probeErrors: Map<string, Error>
let outputs: string[]
let runResult: FfmpegRunResult
let runFailure: Error | undefined
let callId = 0

const VIDEO: FfprobeDocument = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.5' },
  streams: [{ codec_type: 'video', codec_name: 'h264', width: 320, height: 240, avg_frame_rate: '25/1' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', duration: '1.5' }],
}
const SILENT_VIDEO: FfprobeDocument = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.25' },
  streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 360, r_frame_rate: '30/1' }],
}

async function setup(withCanvas = true, fontFile?: string): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), 'dsh-edit-tools-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  provideWorkingDirectoryFixture(ctx, directory)
  if (withCanvas) await ctx.plugin(CanvasService)
  session = Session.create(SessionId(`media-edit-${String(++callId)}`))
  runCalls = []
  probes = new Map()
  probeErrors = new Map()
  outputs = []
  runResult = { stdout: '', stderr: 'dry-run summary' }
  runFailure = undefined
  for (const name of ['input.mp4', 'second.mp4', 'track.mp3']) await writeFile(join(directory, name), name)
  const runner: Pick<FfmpegRunner, 'exec' | 'probe'> = {
    async exec(args, options): Promise<FfmpegRunResult> {
      runCalls.push({ args: [...args], ...(options === undefined ? {} : { options }) })
      if (runFailure !== undefined) throw runFailure
      const output = args.at(-1)
      if (output !== undefined && output !== '-') await writeFile(output, 'rendered')
      return runResult
    },
    async probe(path): Promise<FfprobeDocument> {
      const error = probeErrors.get(path)
      if (error !== undefined) throw error
      return probes.get(path) ?? VIDEO
    },
  }
  registerEditTools(ctx, {
    runner,
    editTimeoutMs: 20_000,
    ...(fontFile === undefined ? {} : { fontFile }),
    writePath: async (extension) => {
      const path = join(directory, `result-${String(outputs.length + 1)}${extension}`)
      outputs.push(path)
      return path
    },
    canvas: () => ctx.get('canvas'),
  })
}

async function call(name: string, args: unknown): Promise<{ readonly text: string; readonly isError: boolean }> {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`edit-${String(++callId)}`),
    name,
    arguments: args,
    agent: { id: session.id, session } as never,
  })
  return {
    text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    isError: result.isError,
  }
}

async function callWithoutAgent(name: string, args: unknown): Promise<{ readonly text: string; readonly isError: boolean }> {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`edit-${String(++callId)}`),
    name,
    arguments: args,
  })
  return {
    text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    isError: result.isError,
  }
}

beforeEach(() => { callId = 0 })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('ffmpeg edit tool', () => {
  it('adds video filter encoding, writes mp4, and links both explicit and path-matched sources once', async () => {
    await setup()
    await ctx.canvas.edit(session, [{ op: 'add', ref: 'source', type: 'video', path: 'input.mp4' }])
    const result = await call('ffmpeg', {
      args: ['-i', 'input.mp4', '-vf', 'scale=640:360'],
      input_node_ids: ['n1'],
      title: 'Scaled clip',
    })
    expect(result).toEqual({ text: `Wrote ${join(directory, 'result-1.mp4')}. Canvas node n2.`, isError: false })
    expect(runCalls[0]!.args).toEqual([
      '-y', '-i', 'input.mp4', '-vf', 'scale=640:360', '-c:v', 'libx264', '-crf', '18', join(directory, 'result-1.mp4'),
    ])
    expect((await ctx.canvas.read(session)).edges).toEqual([{ id: 'n1->n2', source: 'n1', target: 'n2', kind: 'derivation' }])
  })

  it('infers audio extensions, creates audio nodes, and leaves copy outputs with their source extension', async () => {
    await setup()
    const mp3 = await call('ffmpeg', { args: ['-i', 'input.mp4', '-vn', '-c:a', 'libmp3lame'], output_type: 'audio' })
    const copy = await call('ffmpeg', { args: ['-i', 'track.mp3', '-vn', '-c:a', 'copy'], output_type: 'audio' })
    expect(mp3.text).toContain('result-1.mp3')
    expect(copy.text).toContain('result-2.mp3')
    expect((await ctx.canvas.read(session)).nodes.map(node => node.type)).toEqual(['audio', 'audio'])
  })

  it('returns dry-run stderr without writing or placing an artifact', async () => {
    await setup()
    expect(await call('ffmpeg', { args: ['-i', 'input.mp4', '-f', 'null'] })).toEqual({ text: 'dry-run summary', isError: false })
    expect(runCalls[0]!.args).toEqual(['-i', 'input.mp4', '-f', 'null', '-'])
    expect(outputs).toEqual([])
    expect((await ctx.canvas.read(session)).nodes).toEqual([])
  })

  it('uses stdout and a stable fallback when dry-run stderr is empty', async () => {
    await setup()
    runResult = { stdout: '  ffmpeg plan  ', stderr: '' }
    expect(await call('ffmpeg', { args: ['-i', 'input.mp4', '-f', 'null'] }))
      .toEqual({ text: 'ffmpeg plan', isError: false })
    runResult = { stdout: '', stderr: '' }
    expect(await call('ffmpeg', { args: ['-i', 'input.mp4', '-f', 'null'] }))
      .toEqual({ text: 'Dry run completed.', isError: false })
  })

  it('keeps file output usable without a canvas', async () => {
    await setup()
    const result = await call('ffmpeg', { args: ['-i', 'input.mp4'] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('result-1.mp4')
  })

  it('writes media without a session and supports lavfi generated inputs', async () => {
    await setup()
    const generated = await call('ffmpeg', {
      args: ['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1'],
      output_type: 'image',
    })
    expect(generated.text).toContain('result-1.png')
    const detached = await callWithoutAgent('ffmpeg', { args: ['-i', join(directory, 'input.mp4')] })
    expect(detached.text).toContain('result-2.mp4')
    expect(outputs).toHaveLength(2)
  })

  it('derives audio and image output extensions from the selected output type and codec', async () => {
    await setup()
    const cases = [
      { args: ['-i', 'input.mp4'], type: 'audio', extension: '.wav' },
      { args: ['-i', 'input.mp4', '-c:a', 'aac'], type: 'audio', extension: '.m4a' },
      { args: ['-i', 'input.mp4', '-codec:a', 'flac'], type: 'audio', extension: '.flac' },
      { args: ['-i', 'input.mp4', '-acodec', 'libopus'], type: 'audio', extension: '.opus' },
      { args: ['-i', 'input.mp4', '-c:a', 'libvorbis'], type: 'audio', extension: '.ogg' },
      { args: ['-i', 'input.mp4', '-c:a', 'pcm_s16le'], type: 'audio', extension: '.wav' },
      { args: ['-i', 'input.mp4', '-c:a', 'unknown'], type: 'audio', extension: '.wav' },
      { args: ['-i', 'input', '-c:a', 'copy'], type: 'audio', extension: '.wav' },
      { args: ['-i=input.mp4', '-c:a', 'copy'], type: 'audio', extension: '.wav' },
      { args: ['-i', 'input.mp4', '-frames:v', '1'], type: 'image', extension: '.png' },
    ] as const
    for (const [index, item] of cases.entries()) {
      const result = await call('ffmpeg', { args: item.args, output_type: item.type })
      expect(result.text).toContain(`result-${String(index + 1)}${item.extension}`)
    }
  })

  it('does not add an encoder when a filtered video explicitly copies its codec', async () => {
    await setup()
    const result = await call('ffmpeg', {
      args: ['-i', 'input.mp4', '-vf', 'scale=320:240', '-c:v', 'copy'],
    })
    expect(result.isError).toBe(false)
    expect(runCalls[0]?.args).toEqual([
      '-y', '-i', 'input.mp4', '-vf', 'scale=320:240', '-c:v', 'copy', join(directory, 'result-1.mp4'),
    ])
  })

  it('rejects FFmpeg drawtext line-break escapes before executing the command', async () => {
    await setup()
    const result = await call('ffmpeg', {
      args: ['-i', 'input.mp4', '-vf', 'drawtext=text=first\\nsecond'],
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('drawtext does not interpret')
    expect(runCalls).toEqual([])
  })

  it('renders the dry-run fallback summary for a schema-valid result without summary text', async () => {
    await setup()
    const tool = ctx.tools.get('ffmpeg')
    if (tool === undefined) throw new Error('ffmpeg was not registered')
    expect(tool.output.render({}, { path: '', dryRun: true })).toEqual([
      { type: 'text', text: 'Dry run completed.' },
    ])
  })

  it('reports runner failures without writing an artifact', async () => {
    await setup()
    runFailure = new Error('operation timed out')
    const result = await call('ffmpeg', { args: ['-i', 'input.mp4'] })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('operation timed out')
    expect(outputs).toEqual([join(directory, 'result-1.mp4')])
    await expect(access(outputs[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await ctx.canvas.read(session)).nodes).toEqual([])
  })

  it('reports canvas placement failures beside the written file', async () => {
    await setup()
    vi.spyOn(ctx.canvas, 'edit').mockRejectedValue(new Error('canvas is unavailable'))
    const result = await call('ffmpeg', { args: ['-i', 'input.mp4'] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Canvas placement failed: canvas is unavailable')
    expect(outputs).toHaveLength(1)
  })

  it('rejects unsupported inputs, source-id misalignment, and non-ASCII text without a configured font', async () => {
    await setup()
    expect((await call('ffmpeg', { args: ['-i', 'https://example.test/video.mp4'] })).isError).toBe(true)
    expect((await call('ffmpeg', { args: ['-i', 'input.mp4'], input_node_ids: [] })).isError).toBe(true)
    expect((await call('ffmpeg', { args: ['-i', 'input.mp4', '-vf', "drawtext=text='你好'"] })).isError).toBe(true)
    expect(runCalls).toEqual([])
    expect(outputs).toEqual([])
  })
})

describe('merge_videos tool', () => {
  it('probes, normalizes, pads a missing audio track, and creates derivation edges', async () => {
    await setup()
    await ctx.canvas.edit(session, [
      { op: 'add', type: 'video', path: 'input.mp4' },
      { op: 'add', type: 'video', path: 'second.mp4' },
    ])
    probes.set(join(directory, 'input.mp4'), VIDEO)
    probes.set(join(directory, 'second.mp4'), SILENT_VIDEO)
    const result = await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'], input_node_ids: ['n1', ''] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('result-1.mp4')
    const args = runCalls[0]!.args
    expect(args).toContain('-f')
    expect(args).toContain('anullsrc=r=48000:cl=stereo')
    const graph = args[args.indexOf('-filter_complex') + 1]!
    expect(graph).toContain('fps=30')
    expect(graph).toContain('atrim=duration=1.25')
    expect(graph).toContain('concat=n=2:v=1:a=1')
    expect((await ctx.canvas.read(session)).edges).toEqual([
      { id: 'n1->n3', source: 'n1', target: 'n3', kind: 'derivation' },
      { id: 'n2->n3', source: 'n2', target: 'n3', kind: 'derivation' },
    ])
  })

  it('supports custom dimensions and rejects invalid modes, missing video, and too few inputs', async () => {
    await setup()
    probes.set(join(directory, 'input.mp4'), VIDEO)
    probes.set(join(directory, 'second.mp4'), SILENT_VIDEO)
    expect((await call('merge_videos', { video_paths: ['input.mp4'] })).isError).toBe(true)
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'https://example.test/clip.mp4'] })).isError).toBe(true)
    const custom = await call('merge_videos', {
      video_paths: ['input.mp4', 'second.mp4'], scale_mode: 'custom', target_width: 800, target_height: 600,
    })
    expect(custom.isError).toBe(false)
    expect(runCalls.at(-1)!.args.join(' ')).toContain('scale=800:600')
    expect((await call('merge_videos', {
      video_paths: ['input.mp4', 'second.mp4'], scale_mode: 'custom',
    })).isError).toBe(true)
    expect((await call('merge_videos', {
      video_paths: ['input.mp4', 'second.mp4'], scale_mode: 'custom', target_width: 1, target_height: 1,
    })).isError).toBe(true)
    probes.set(join(directory, 'input.mp4'), { streams: [], format: { duration: '1' } })
    probes.set(join(directory, 'second.mp4'), { streams: [], format: { duration: '1' } })
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'] })).isError).toBe(true)
  })

  it('supports max and min dimensions and requires dimensions after video streams are found', async () => {
    await setup()
    probes.set(join(directory, 'input.mp4'), VIDEO)
    probes.set(join(directory, 'second.mp4'), SILENT_VIDEO)
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'], scale_mode: 'max' })).isError).toBe(false)
    expect(runCalls.at(-1)!.args.join(' ')).toContain('scale=640:360')
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'], scale_mode: 'min' })).isError).toBe(false)
    expect(runCalls.at(-1)!.args.join(' ')).toContain('scale=320:240')
    probes.set(join(directory, 'second.mp4'), { streams: [{ codec_type: 'audio' }] })
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'] })).isError).toBe(true)
  })

  it('uses both comparison outcomes when selecting maximum and minimum dimensions', async () => {
    await setup()
    probes.set(join(directory, 'input.mp4'), SILENT_VIDEO)
    probes.set(join(directory, 'second.mp4'), VIDEO)
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'], scale_mode: 'max' })).isError).toBe(false)
    expect(runCalls.at(-1)?.args.join(' ')).toContain('scale=640:360')
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'], scale_mode: 'min' })).isError).toBe(false)
    expect(runCalls.at(-1)?.args.join(' ')).toContain('scale=320:240')
  })

  it('uses safe durations when ffprobe omits or reports an invalid duration', async () => {
    await setup()
    probes.set(join(directory, 'second.mp4'), {
      format: { duration: 'not a duration' },
      streams: [{ codec_type: 'video', width: 640, height: 360 }],
    })
    const result = await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'] })
    expect(result.isError).toBe(false)
    expect(runCalls[0]?.args).toContain('1')
    expect(runCalls[0]?.args.join(' ')).toContain('atrim=duration=0.1')
  })

  it('rejects a video stream whose dimensions cannot be probed', async () => {
    await setup()
    probes.set(join(directory, 'input.mp4'), { streams: [{ codec_type: 'video' }] })
    probes.set(join(directory, 'second.mp4'), { streams: [{ codec_type: 'video' }] })
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'] })).text)
      .toContain('needs video streams with probeable dimensions')
  })

  it('rejects ffprobe results that omit the stream list', async () => {
    await setup()
    probes.set(join(directory, 'second.mp4'), { format: { duration: '1' } })
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'] })).text)
      .toContain('requires each input to contain a video stream')
  })

  it('surfaces ffprobe errors and misaligned source ids before producing output', async () => {
    await setup()
    const probePath = join(directory, 'input.mp4')
    probeErrors.set(probePath, new Error('ffprobe failed'))
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'] })).text).toContain('ffprobe failed')
    expect((await call('merge_videos', {
      video_paths: ['input.mp4', 'second.mp4'], input_node_ids: ['n1'],
    })).text).toContain('input_node_ids must align')
    expect(outputs).toEqual([])
    expect(runCalls).toEqual([])
  })
})

describe('media_probe tool', () => {
  it('returns stream facts for paths and canvas nodes', async () => {
    await setup()
    await ctx.canvas.edit(session, [{ op: 'add', type: 'video', path: 'input.mp4' }])
    probes.set(join(directory, 'input.mp4'), VIDEO)
    const byPath = await call('media_probe', { path: 'input.mp4' })
    const byNode = await call('media_probe', { node_id: 'n1' })
    expect(byPath.isError).toBe(false)
    expect(byPath.text).toContain('2.5s')
    expect(byNode.isError).toBe(false)
    expect(byNode.text).toContain('2 stream(s)')
  })

  it('formats sparse probe documents and reports probe failures', async () => {
    await setup()
    const path = join(directory, 'input.mp4')
    probes.set(path, {
      streams: [{ duration: '1.25', r_frame_rate: '24/1' }, { codec_type: 'audio', channels: 1, sample_rate: 'invalid' }],
    })
    const sparse = await call('media_probe', { path })
    expect(sparse.isError).toBe(false)
    expect(sparse.text).toContain('1.25s')
    expect(sparse.text).toContain('unknown')
    expect(sparse.text).not.toContain('NaN')
    probeErrors.set(path, new Error('ffprobe unavailable'))
    expect((await call('media_probe', { path })).text).toContain('ffprobe unavailable')
  })

  it('reports empty probe documents as unknown media with zero duration', async () => {
    await setup()
    probes.set(join(directory, 'input.mp4'), {})
    const result = await call('media_probe', { path: 'input.mp4' })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('0s, unknown; 0 stream(s)')
  })

  it('contains missing, Error, and non-Error canvas media resolution failures', async () => {
    await setup()
    vi.spyOn(ctx.canvas, 'resolveMedia').mockResolvedValueOnce([])
    expect((await call('media_probe', { node_id: 'n1' })).text)
      .toContain('canvas node n1 did not resolve to a media path')

    vi.spyOn(ctx.canvas, 'resolveMedia').mockRejectedValueOnce(new Error('canvas unavailable'))
    expect((await call('media_probe', { node_id: 'n1' })).text).toContain('media_probe: canvas unavailable')

    vi.spyOn(ctx.canvas, 'resolveMedia').mockRejectedValueOnce('canvas read failed')
    expect((await call('media_probe', { node_id: 'n1' })).text).toContain('media_probe: canvas read failed')
  })

  it('rejects device paths before asking ffprobe to open them', async () => {
    await setup()
    expect((await call('media_probe', { path: '/dev/null' })).text).toContain('Only local input files are allowed')
    expect(runCalls).toEqual([])
  })

  it('requires exactly one source and needs a canvas to resolve node ids', async () => {
    await setup(false)
    expect((await call('media_probe', {})).isError).toBe(true)
    expect((await call('media_probe', { path: 'input.mp4', node_id: 'n1' })).isError).toBe(true)
    expect((await call('media_probe', { node_id: 'n1' })).text).toContain('needs a canvas session')
  })
})
