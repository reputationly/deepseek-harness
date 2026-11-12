import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
let outputs: string[]
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
  outputs = []
  for (const name of ['input.mp4', 'second.mp4', 'track.mp3']) await writeFile(join(directory, name), name)
  const runner: Pick<FfmpegRunner, 'exec' | 'probe'> = {
    async exec(args, options): Promise<FfmpegRunResult> {
      runCalls.push({ args: [...args], ...(options === undefined ? {} : { options }) })
      return { stdout: '', stderr: 'dry-run summary' }
    },
    async probe(path): Promise<FfprobeDocument> {
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
      await writeFile(path, 'rendered')
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

  it('keeps file output usable without a canvas', async () => {
    await setup()
    const result = await call('ffmpeg', { args: ['-i', 'input.mp4'] })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('result-1.mp4')
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
    probes.set(join(directory, 'input.mp4'), { streams: [], format: { duration: '1' } })
    probes.set(join(directory, 'second.mp4'), { streams: [], format: { duration: '1' } })
    expect((await call('merge_videos', { video_paths: ['input.mp4', 'second.mp4'] })).isError).toBe(true)
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

  it('requires exactly one source and needs a canvas to resolve node ids', async () => {
    await setup(false)
    expect((await call('media_probe', {})).isError).toBe(true)
    expect((await call('media_probe', { path: 'input.mp4', node_id: 'n1' })).isError).toBe(true)
    expect((await call('media_probe', { node_id: 'n1' })).text).toContain('needs a canvas session')
  })
})
