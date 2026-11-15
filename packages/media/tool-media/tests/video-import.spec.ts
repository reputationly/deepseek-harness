/** Upload imports share the canvas candidate writer and retain verified bytes after failure. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CanvasService from '@deepseek-ai/dsh-canvas'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { EpisodeId, TimelineClipId, TimelineTrackId } from '@deepseek-ai/dsh-canvas/client'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalMediaImporter } from '../src/media-import.ts'
import type { FfprobeDocument } from '../src/ffmpeg.ts'
import type { NodeToolDeps } from '../src/node-tools.ts'

let ctx: Context, directory: string, session: Session
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-video-import-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService)
  session = Session.create(SessionId('video-import'))
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
})

async function fixture(kind: 'video' | 'audio' = 'video', empty = false) {
  const path = join(directory, kind === 'video' ? 'original.mp4' : 'original.wav')
  await writeFile(path, 'original')
  const edit = await ctx.canvas.edit(session, [
    {
      op: 'add',
      type: kind,
      ...(empty
        ? { gen: { kind: kind === 'audio' ? ('music' as const) : ('video' as const), prompt: '', params: {} } }
        : { path }),
      title: 'Local media',
      ref: 'source',
    },
  ])
  const request = {
    scope: { directory, episode: brandString<EpisodeId>('e1') },
    node: edit.refs.source!,
    receipt: brandString<FileUploadReceiptId>('upload'),
  }
  const probe = vi.fn(
    async (): Promise<FfprobeDocument> => ({
      streams: [
        kind === 'video' ? { codec_type: 'video', width: 180, height: 320 } : { codec_type: 'audio', duration: '1.25' },
      ],
      format: { duration: '2' },
    }),
  )
  const start = vi.fn<ReturnType<NodeToolDeps['jobs']>['start']>((spec) => {
    const signal = new AbortController().signal
    return { id: brandString<JobId>('import'), signal, done: spec.run(signal) }
  })
  const importer = new LocalMediaImporter({
    canvas: () => ctx.canvas,
    jobs: () => ({ start }),
    ffmpeg: { probe },
    report: vi.fn(),
  })
  const data = vi.fn(async function* () {
    yield new Uint8Array([1, 2])
    yield new Uint8Array([3, 4])
  })
  const source = { key: 'verified-attachment', name: kind === 'video' ? 'clip.mp4' : 'clip.wav', data }
  return { importer, request, source, probe, start }
}

it('imports the first audio candidate into an empty node using its measured audio duration', async () => {
  const h = await fixture('audio', true)
  const result = await h.importer.import(session, h.request, h.source, 'audio')
  const node = (await ctx.canvas.read(session)).nodes[0]!
  expect(node.activeVersion).toBeUndefined()
  expect(node.versions).toHaveLength(1)
  expect(node.versions?.[0]).toMatchObject({ id: result.version, durationMs: 1250, origin: 'user' })
  expect(node.versions?.[0]).not.toHaveProperty('width')
  expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ local: true, completionNotice: 'none' }))
  expect(await readFile(result.path)).toEqual(Buffer.from([1, 2, 3, 4]))
})

it('preserves the adopted audio and deduplicates repeated audio imports', async () => {
  const h = await fixture('audio')
  const adoption = (await ctx.canvas.read(session)).nodes[0]!.activeVersion
  const [first, repeated] = await Promise.all([
    h.importer.import(session, h.request, h.source, 'audio'),
    h.importer.import(session, h.request, h.source, 'audio'),
  ])
  expect(first).toEqual(repeated)
  const expectedVersions1: unknown = expect.any(Array)
  expect((await ctx.canvas.read(session)).nodes[0]).toMatchObject({
    activeVersion: adoption,
    versions: expectedVersions1,
  })
  expect((await ctx.canvas.read(session)).nodes[0]!.versions).toHaveLength(2)
  expect(h.source.data).toHaveBeenCalledTimes(1)
})

it('rejects audio uploads without an audio stream and retains their completed bytes', async () => {
  const h = await fixture('audio', true)
  h.probe.mockResolvedValueOnce({
    streams: [{ codec_type: 'video', width: 180, height: 320 }],
    format: { duration: '2' },
  })
  const expectedPath2: unknown = expect.any(String)
  await expect(h.importer.import(session, h.request, h.source, 'audio')).rejects.toMatchObject({
    code: 'input',
    path: expectedPath2,
  })
  expect((await ctx.canvas.read(session)).nodes[0]!.versions ?? []).toHaveLength(0)
  expect(await readdir(join(directory, '.canvas', 'imports'))).toHaveLength(1)
})

it('rejects a video destination for audio before consuming the staged stream', async () => {
  const h = await fixture()
  await expect(h.importer.import(session, h.request, h.source, 'audio')).rejects.toMatchObject({ code: 'input' })
  expect(h.source.data).not.toHaveBeenCalled()
})

it('streams exact bytes once and appends one unadopted candidate across identical imports', async () => {
  const h = await fixture()
  const before = (await ctx.canvas.read(session)).nodes[0]!.activeVersion
  const [saved, concurrent] = await Promise.all([
    h.importer.import(session, h.request, h.source),
    h.importer.import(session, h.request, h.source),
  ])
  expect(saved).toEqual(concurrent)
  expect(await readFile(saved.path)).toEqual(Buffer.from([1, 2, 3, 4]))
  const node = (await ctx.canvas.read(session)).nodes[0]!
  expect(node.activeVersion).toBe(before)
  expect(node.versions).toHaveLength(2)
  expect(node.versions?.find(version => version.id === saved.version)).toMatchObject({
    width: 180,
    height: 320,
    durationMs: 2000,
    origin: 'user',
  })
  await expect(h.importer.import(session, h.request, h.source)).resolves.toMatchObject({
    version: saved.version,
    reused: true,
  })
  expect(h.source.data).toHaveBeenCalledTimes(1)
  expect(h.start.mock.calls[0]![0].local).toBe(true)
})

it.each(['video', 'audio'] as const)(
  'pins an imported %s candidate in a saved timeline without changing adoption',
  async (kind) => {
    const h = await fixture(kind)
    const adopted = (await ctx.canvas.read(session)).nodes[0]!.activeVersion
    const imported = await h.importer.import(session, h.request, h.source, kind)
    const added = await ctx.canvas.edit(session, [{ op: 'add', type: 'timeline', ref: 'cut' }])
    const timeline = added.refs.cut!
    const source = { node: h.request.node, version: imported.version, inMs: 0 }
    const saved = await ctx.canvas.editTimeline(
      session,
      timeline,
      [
        {
          op: 'add_track',
          track: {
            id: brandString<TimelineTrackId>('t1'),
            kind,
            muted: false,
            volume: 1,
            clips: [{ id: brandString<TimelineClipId>('k1'), startMs: 0, durationMs: 1000, source }],
          },
        },
      ],
      0,
      { width: 720, height: 1280, fps: 24 },
      h.request.scope.episode,
      h.request.scope.directory,
    )
    expect(saved.document.tracks[0]?.clips[0]?.source).toEqual(source)
    expect(await ctx.canvas.timeline(session, timeline, h.request.scope.episode, h.request.scope.directory)).toEqual(
      saved.document,
    )
    const media = (await ctx.canvas.read(session)).nodes.find(node => node.id === h.request.node)!
    expect(media.activeVersion).toBe(adopted)
    expect(media.versions?.find(version => version.id === imported.version)?.path).toBe(imported.path)
  },
)

it('keeps complete bytes when probing is interrupted and reuses them on explicit retry', async () => {
  const h = await fixture()
  h.probe.mockRejectedValueOnce(new Error('probe interrupted'))
  const expectedPath3: unknown = expect.stringContaining('imports')
  await expect(h.importer.import(session, h.request, h.source)).rejects.toMatchObject({
    code: 'processing',
    path: expectedPath3,
  })
  expect(await readdir(join(directory, '.canvas', 'imports'))).toHaveLength(1)
  await expect(h.importer.import(session, h.request, h.source)).resolves.toMatchObject({ reused: true })
  expect(h.source.data).toHaveBeenCalledTimes(1)
})

it('retains the uploaded file when its destination is deleted during probing', async () => {
  const h = await fixture()
  h.probe.mockImplementationOnce(async () => {
    await ctx.canvas.edit(session, [{ op: 'remove', node: h.request.node }])
    return { streams: [{ codec_type: 'video', width: 180, height: 320 }], format: { duration: '2' } }
  })
  const expectedPath4: unknown = expect.stringContaining('imports')
  await expect(h.importer.import(session, h.request, h.source)).rejects.toMatchObject({
    code: 'source_changed',
    path: expectedPath4,
  })
  expect(await readdir(join(directory, '.canvas', 'imports'))).toHaveLength(1)
  expect((await ctx.canvas.read(session)).nodes).toHaveLength(0)
})

it('removes an unverified partial stream without creating a media candidate', async () => {
  const h = await fixture()
  const source = {
    ...h.source,
    data: async function* () {
      yield new Uint8Array([1])
      throw new Error('integrity check failed')
    },
  }
  await expect(h.importer.import(session, h.request, source)).rejects.toMatchObject({ code: 'processing' })
  expect(await readdir(join(directory, '.canvas', 'imports'))).toHaveLength(0)
  expect((await ctx.canvas.read(session)).nodes[0]!.versions).toHaveLength(1)
})

it('retains complete bytes after attachment failure and reuses them on an explicit successful retry', async () => {
  const h = await fixture()
  const adoption = (await ctx.canvas.read(session)).nodes[0]!.activeVersion
  const commit = vi.spyOn(ctx.canvas, 'edit').mockRejectedValueOnce(new Error('canvas write failed'))
  const expectedPath5: unknown = expect.stringContaining('imports')
  await expect(h.importer.import(session, h.request, h.source)).rejects.toMatchObject({
    code: 'attachment',
    path: expectedPath5,
  })
  expect((await ctx.canvas.read(session)).nodes[0]!.versions).toHaveLength(1)
  expect(await readdir(join(directory, '.canvas', 'imports'))).toHaveLength(1)
  commit.mockRestore()
  await expect(h.importer.import(session, h.request, h.source)).resolves.toMatchObject({ reused: true })
  const node = (await ctx.canvas.read(session)).nodes[0]!
  expect(node.versions).toHaveLength(2)
  expect(node.activeVersion).toBe(adoption)
  expect(h.source.data).toHaveBeenCalledTimes(1)
})
