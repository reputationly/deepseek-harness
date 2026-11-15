/** Opt-in native FFmpeg integration: run with DSH_TEST_LOCAL_FFMPEG=1 and configured binaries on PATH. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CanvasService from '@deepseek-ai/dsh-canvas'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { EpisodeId } from '@deepseek-ai/dsh-canvas/client'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalMediaEditor } from '../src/local-edit.ts'
import { FfmpegRunner } from '../src/ffmpeg.ts'
import { LocalMediaImporter } from '../src/media-import.ts'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'

describe.skipIf(process.env.DSH_TEST_LOCAL_FFMPEG !== '1')('local edits with real FFmpeg', () => {
  let directory: string, ctx: Context, runner: FfmpegRunner, editor: LocalMediaEditor, session: Session
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-local-native-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    provideWorkingDirectoryFixture(ctx, directory)
    await ctx.plugin(CanvasService)
    runner = new FfmpegRunner(new LocalSubprocessRuntime(ctx), 'ffmpeg', 'ffprobe', 30_000)
    session = Session.create(SessionId('local-native'))
    editor = new LocalMediaEditor({
      canvas: () => ctx.canvas,
      ffmpeg: runner,
      outputDir: directory,
      jobs: () => ({
        start: (spec) => {
          const signal = new AbortController().signal
          return { id: brandString<JobId>('native-job'), signal, done: spec.run(signal) }
        },
      }),
      report: (error) => {
        throw error
      },
    })
  })
  afterEach(async () => {
    await runner.dispose()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  async function source(type: 'audio' | 'video', path: string) {
    const result = await ctx.canvas.edit(session, [{ op: 'add', ref: 'source', type, path, title: 'Native source' }])
    const node = result.refs.source!
    const version = (await ctx.canvas.read(session)).nodes.find(item => item.id === node)!.activeVersion!
    return { scope: { directory, episode: brandString<EpisodeId>('e1') }, node, version }
  }

  it('imports real video bytes as an exact candidate with measured duration and dimensions', async () => {
    const path = join(directory, 'upload.mp4')
    await runner.exec([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=1:size=64x48:rate=5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path,
    ])
    const input = await source('video', path)
    const importer = new LocalMediaImporter({
      canvas: () => ctx.canvas,
      ffmpeg: runner,
      report: (error) => {
        throw error
      },
      jobs: () => ({
        start: (spec) => {
          const signal = new AbortController().signal
          return { id: brandString<JobId>('import-native'), signal, done: spec.run(signal) }
        },
      }),
    })
    const result = await importer.import(
      session,
      { ...input, receipt: brandString<FileUploadReceiptId>('native-receipt') },
      {
        key: 'native-upload',
        name: 'upload.mp4',
        data: () => createReadStream(path),
      },
    )
    expect(await readFile(result.path)).toEqual(await readFile(path))
    const node = (await ctx.canvas.read(session)).nodes.find(node => node.id === input.node)!
    expect(node.activeVersion).toBe(input.version)
    expect(node.versions?.find(version => version.id === result.version)).toMatchObject({
      durationMs: 1000,
      width: 64,
      height: 48,
    })
  }, 20_000)

  it('imports real WAV bytes as an audio candidate without changing adoption', async () => {
    const path = join(directory, 'upload.wav')
    await runner.exec(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.25', path])
    const input = await source('audio', path)
    const importer = new LocalMediaImporter({
      canvas: () => ctx.canvas,
      ffmpeg: runner,
      report: (error) => {
        throw error
      },
      jobs: () => ({
        start: (spec) => {
          const signal = new AbortController().signal
          return { id: brandString<JobId>('import-native-audio'), signal, done: spec.run(signal) }
        },
      }),
    })
    const result = await importer.import(
      session,
      { scope: input.scope, node: input.node, receipt: brandString<FileUploadReceiptId>('native-audio-receipt') },
      {
        key: 'native-audio-upload',
        name: 'upload.wav',
        data: () => createReadStream(path),
      },
      'audio',
    )
    expect(await readFile(result.path)).toEqual(await readFile(path))
    const node = (await ctx.canvas.read(session)).nodes.find(node => node.id === input.node)!
    expect(node.activeVersion).toBe(input.version)
    expect(node.versions?.find(version => version.id === result.version)).toMatchObject({
      durationMs: 1250,
      origin: 'user',
    })
  }, 20_000)

  it('renders the trimmed duration, gain, and fades into the saved WAV bytes', async () => {
    const path = join(directory, 'tone.wav')
    await runner.exec(['-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=3', path])
    const input = await source('audio', path)
    const result = await editor.edit(session, {
      ...input,
      operation: 'audio_edit',
      inMs: 1000,
      outMs: 2500,
      volume: 0.5,
      fadeInMs: 200,
      fadeOutMs: 300,
    })
    expect(Number((await runner.probe(result.path)).format?.duration)).toBeCloseTo(1.5, 3)
    const pcm = join(directory, 'decoded.f32')
    await runner.exec(['-i', result.path, '-f', 'f32le', '-c:a', 'pcm_f32le', pcm])
    const bytes = await readFile(pcm)
    const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const rms = (from: number, to: number): number => {
      let sum = 0,
        count = 0
      for (let sample = Math.floor(from * 48_000); sample < Math.floor(to * 48_000); sample++) {
        sum += samples.getFloat32(sample * 4, true) ** 2
        count++
      }
      return Math.sqrt(sum / count)
    }
    const middle = rms(0.6, 0.8)
    expect(middle).toBeCloseTo(0.25 / Math.sqrt(2), 4)
    expect(rms(0, 0.05)).toBeLessThan(middle * 0.2)
    expect(rms(1.45, 1.5)).toBeLessThan(middle * 0.15)
    expect((await ctx.canvas.read(session)).nodes[0]!.activeVersion).toBe(input.version)
  }, 20_000)

  it('captures the exact final VFR frame independently of container duration', async () => {
    const path = join(directory, 'vfr.mp4')
    await runner.exec([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=2:size=64x48:rate=5',
      '-vf',
      'settb=1/1000,setpts=N*N*50',
      '-fps_mode',
      'vfr',
      '-enc_time_base',
      '1/1000',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      path,
    ])
    const input = await source('video', path)
    const result = await editor.edit(session, { ...input, operation: 'refresh_tail', title: 'Exact tail' })
    const reference = join(directory, 'reference.png')
    // Reversing this ten-frame fixture gives an independent reference without timestamp seeking.
    await runner.exec(['-i', path, '-vf', 'reverse', '-frames:v', '1', '-map_metadata', '-1', reference])
    expect((await readFile(result.path)).equals(await readFile(reference))).toBe(true)
    expect((await ctx.canvas.read(session)).nodes.find(node => node.id === input.node)?.tailOf?.sourceVersion).toBe(
      input.version,
    )
  }, 20_000)
})
