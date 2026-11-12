import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerEditTools } from '../src/edit-tools.ts'
import { FfmpegRunner } from '../src/ffmpeg.ts'

const ffmpeg = '/usr/bin/ffmpeg'
const ffprobe = '/usr/bin/ffprobe'
const available = existsSync(ffmpeg) && existsSync(ffprobe)
let root: string
let ctx: Context
let runner: FfmpegRunner
let session: Session
let outputIndex = 0
let callIndex = 0

afterEach(async () => {
  runner?.dispose()
  if (ctx !== undefined) await ctx.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('local FFmpeg editing', () => {
  it.skipIf(!available)('extracts, clips, extracts a frame, and merges a silent segment', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-real-ffmpeg-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    provideWorkingDirectoryFixture(ctx, root)
    runner = new FfmpegRunner(ffmpeg, ffprobe, 120_000)
    session = Session.create(SessionId('local-ffmpeg-session'))
    const input = join(root, 'source.mp4')
    const silent = join(root, 'silent.mp4')
    const outputs: string[] = []
    registerEditTools(ctx, {
      runner,
      editTimeoutMs: 120_000,
      canvas: () => undefined,
      writePath: async (extension) => {
        const path = join(root, `result-${String(++outputIndex)}${extension}`)
        outputs.push(path)
        return path
      },
    })
    await runner.exec([
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=15:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input,
    ], { cwd: root, timeoutMs: 120_000 })
    await runner.exec([
      '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=15:d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent,
    ], { cwd: root, timeoutMs: 120_000 })

    const call = async (name: string, args: unknown) => executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId(`real-ffmpeg-${String(++callIndex)}`),
      name,
      arguments: args,
      agent: { id: session.id, session } as never,
    })
    const extraction = await call('ffmpeg', { args: ['-i', input, '-vn', '-c:a', 'aac'], output_type: 'audio' })
    const clipping = await call('ffmpeg', {
      args: ['-i', input, '-ss', '1', '-to', '2', '-c:v', 'libx264', '-c:a', 'aac'],
    })
    const frame = await call('ffmpeg', { args: ['-i', input, '-ss', '1', '-frames:v', '1'], output_type: 'image' })
    expect([extraction.isError, clipping.isError, frame.isError]).toEqual([false, false, false])
    const merge = await call('merge_videos', { video_paths: [outputs[1]!, silent] })
    expect(merge.isError).toBe(false)

    const audio = await runner.probe(outputs[0]!)
    const clip = await runner.probe(outputs[1]!)
    const image = await runner.probe(outputs[2]!)
    const joined = await runner.probe(outputs[3]!)
    expect(audio.streams?.map(stream => stream.codec_type)).toEqual(['audio'])
    expect(clip.streams?.some(stream => stream.codec_type === 'video')).toBe(true)
    expect(Number(clip.format?.duration)).toBeGreaterThan(0.8)
    expect(Number(clip.format?.duration)).toBeLessThan(1.3)
    expect(image.streams?.map(stream => stream.codec_type)).toEqual(['video'])
    expect(await stat(outputs[2]!).then(result => result.size)).toBeGreaterThan(0)
    expect(joined.streams?.some(stream => stream.codec_type === 'video')).toBe(true)
    expect(joined.streams?.some(stream => stream.codec_type === 'audio')).toBe(true)
    expect(Number(joined.format?.duration)).toBeGreaterThan(1.8)
  }, 180_000)
})
