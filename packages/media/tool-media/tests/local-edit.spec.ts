/** Local editing preserves adopted media, exact source history, and recoverable completed artifacts. */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CanvasService from '@deepseek-ai/dsh-canvas'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { EpisodeId, TimelineClipId, TimelineTrackId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalMediaEditor } from '../src/local-edit.ts'
import type { FfprobeDocument, FfmpegRunOptions } from '../src/ffmpeg.ts'
import type { NodeToolDeps } from '../src/node-tools.ts'
import type { LocalMediaEditRequest } from '../src/local-edit-types.ts'

let ctx: Context, directory: string, session: Session
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-local-edit-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService)
  session = Session.create(SessionId('local-edit'))
})
afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
})

async function fixture(type: 'audio' | 'video' = 'audio') {
  const path = join(directory, `source.${type === 'audio' ? 'wav' : 'mp4'}`)
  await writeFile(path, 'source')
  const result = await ctx.canvas.edit(session, [{ op: 'add', ref: 'source', type, path, title: 'Source' }])
  const node = result.refs.source!
  const scope = { directory, episode: brandString<EpisodeId>('e1') }
  const version = (await ctx.canvas.read(session)).nodes.find(item => item.id === node)!.activeVersion!
  const controllers: AbortController[] = []
  const start = vi.fn<ReturnType<NodeToolDeps['jobs']>['start']>((spec) => {
    const controller = new AbortController()
    controllers.push(controller)
    return {
      id: brandString<JobId>(`j${controllers.length}`),
      done: spec.run(controller.signal),
      signal: controller.signal,
    }
  })
  const jobs = vi.fn<NodeToolDeps['jobs']>(() => ({ start }))
  const probe = vi.fn(
    async (file: string): Promise<FfprobeDocument> => ({
      streams: file.endsWith('.png')
        ? [{ codec_type: 'video', width: 180, height: 320 }]
        : type === 'video' && file === path
          ? [
            { codec_type: 'video', width: 320, height: 180, nb_read_frames: '41' },
            { codec_type: 'audio', duration: '4' },
          ]
          : [{ codec_type: 'audio', duration: file === path ? '4' : '1.5' }],
    }),
  )
  const exec = vi.fn(async (args: readonly string[], _options?: FfmpegRunOptions) => {
    await writeFile(args.at(-1)!, 'completed')
    return { stdout: '', stderr: '' }
  })
  const editor = new LocalMediaEditor({
    canvas: () => ctx.canvas,
    jobs,
    ffmpeg: { probe, exec },
    outputDir: directory,
    report: vi.fn(),
  })
  const request: LocalMediaEditRequest = {
    scope,
    node,
    version,
    operation: 'audio_edit',
    inMs: 1000,
    outMs: 2500,
    volume: 0.5,
    fadeInMs: 100,
    fadeOutMs: 300,
  }
  return { editor, exec, probe, jobs, start, controllers, node, version, path, scope, request }
}

it('suppresses model completion notices only for an explicitly UI-owned local edit', async () => {
  const h = await fixture()
  await h.editor.edit(session, h.request, 'none')
  expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ local: true, completionNotice: 'none' }))
})

it('keeps normal job notification policy for a model-owned edit', async () => {
  const h = await fixture()
  await h.editor.edit(session, h.request)
  expect(h.start.mock.calls[0]?.[0]).not.toHaveProperty('completionNotice')
})

it('stores trimmed audio as a candidate with exact source data and rendered fades', async () => {
  const h = await fixture()
  const result = await h.editor.edit(session, h.request)
  const node = (await ctx.canvas.read(session)).nodes.find(node => node.id === h.node)!
  expect(node.activeVersion).toBe(h.version)
  expect(node.versions).toHaveLength(2)
  expect(node.versions?.find(version => version.id === result.version)).toMatchObject({
    origin: 'user',
    path: result.path,
    durationMs: 1500,
    inputs: [{ node: h.node, version: h.version, path: h.path, role: 'source' }],
  })
  expect(h.exec.mock.calls[0]![0]).toContain(
    'atrim=start=1:end=2.5,asetpts=PTS-STARTPTS,volume=0.5,afade=t=in:st=0:d=0.1,afade=t=out:st=1.2:d=0.3',
  )
})

it('pins an edited audio candidate through timeline persistence without adopting it', async () => {
  const h = await fixture()
  const edited = await h.editor.edit(session, h.request)
  const added = await ctx.canvas.edit(session, [{ op: 'add', type: 'timeline', ref: 'cut' }])
  const timeline = added.refs.cut!
  const source = { node: h.node, version: edited.version, inMs: 0 }
  const saved = await ctx.canvas.editTimeline(
    session,
    timeline,
    [
      {
        op: 'add_track',
        track: {
          id: brandString<TimelineTrackId>('t1'),
          kind: 'audio',
          muted: false,
          volume: 1,
          clips: [{ id: brandString<TimelineClipId>('k1'), startMs: 0, durationMs: 1500, source }],
        },
      },
    ],
    0,
    { width: 720, height: 1280, fps: 24 },
    h.scope.episode,
    h.scope.directory,
  )
  expect(saved.document.tracks[0]?.clips[0]?.source).toEqual(source)
  expect(await ctx.canvas.timeline(session, timeline, h.scope.episode, h.scope.directory)).toEqual(saved.document)
  expect((await ctx.canvas.read(session)).nodes.find(node => node.id === h.node)?.activeVersion).toBe(h.version)
})

it('shares concurrent work and returns the same candidate after an unconfirmed response', async () => {
  const h = await fixture()
  const [first, concurrent] = await Promise.all([h.editor.edit(session, h.request), h.editor.edit(session, h.request)])
  expect(concurrent.version).toBe(first.version)
  await expect(h.editor.edit(session, h.request)).resolves.toMatchObject({ version: first.version, reused: true })
  expect(h.jobs).toHaveBeenCalledTimes(1)
  expect(h.exec).toHaveBeenCalledTimes(1)
  expect((await ctx.canvas.read(session)).nodes[0]!.versions).toHaveLength(2)
})

it('retains the exact source model, prompt, score, lyrics, style, and zero seed when editing audio', async () => {
  const h = await fixture()
  const source = {
    id: brandString<VersionId>('song-source'),
    path: h.path,
    model: 'yue2',
    prompt: 'Original song',
    createdAt: 'now',
    origin: 'agent' as const,
    params: { lyrics: 'Original words', style: 'acoustic', seed: 0, abc: 'X:1\nK:C\nC4 |' },
  }
  await ctx.canvas.edit(session, [{ op: 'append_version', node: h.node, version: source }])
  const edited = await h.editor.edit(session, { ...h.request, version: source.id })
  expect(
    (await ctx.canvas.read(session)).nodes[0]!.versions?.find(version => version.id === edited.version),
  ).toMatchObject({
    model: source.model,
    prompt: source.prompt,
    params: source.params,
  })
})

it('keeps a fully encoded file when cancellation interrupts output probing and reuses it on explicit retry', async () => {
  const h = await fixture()
  const probe = h.probe.getMockImplementation()!
  h.probe.mockImplementationOnce(probe).mockImplementationOnce(async () => {
    h.controllers[0]!.abort()
    throw new Error('output probe cancelled')
  })
  const expectedPath1: unknown = expect.stringMatching(/local-.+\.wav$/u)
  await expect(h.editor.edit(session, h.request)).rejects.toMatchObject({
    code: 'processing',
    path: expectedPath1,
  })
  expect((await readdir(directory)).filter(path => path.startsWith('local-'))).toHaveLength(1)
  expect((await ctx.canvas.read(session)).nodes[0]!.versions).toHaveLength(1)
  await h.editor.edit(session, h.request)
  expect(h.exec).toHaveBeenCalledTimes(1)
})

it('retains unusable completed output separately and renders again on explicit retry', async () => {
  const h = await fixture()
  const probe = h.probe.getMockImplementation()!
  h.probe.mockImplementationOnce(probe).mockImplementationOnce(async () => ({ streams: [] }))
  const expectedPath2: unknown = expect.stringContaining('-unusable-')
  await expect(h.editor.edit(session, h.request)).rejects.toMatchObject({
    code: 'processing',
    path: expectedPath2,
  })
  await h.editor.edit(session, h.request)
  expect(h.exec).toHaveBeenCalledTimes(2)
  expect((await readdir(directory)).filter(path => path.startsWith('local-'))).toHaveLength(2)
})

it('does not refresh a continuity cache when the source was unadopted at the start', async () => {
  const h = await fixture('video')
  await ctx.canvas.edit(session, [{ op: 'set_version', node: h.node, version: null }])
  h.exec.mockImplementationOnce(async (args) => {
    await writeFile(args.at(-1)!, 'complete')
    await ctx.canvas.edit(session, [{ op: 'set_version', node: h.node, version: h.version }])
    return { stdout: '', stderr: '' }
  })
  const result = await h.editor.edit(session, { ...h.request, operation: 'refresh_tail', title: 'Tail' })
  expect((await ctx.canvas.read(session)).nodes.find(node => node.id === h.node)!.tailOf).toBeUndefined()
  expect(result.node).not.toBe(h.node)
})

it('rejects the entire attachment if a required operation is skipped and preserves the completed file', async () => {
  const h = await fixture('video')
  const edit = ctx.canvas.edit.bind(ctx.canvas)
  vi.spyOn(ctx.canvas, 'edit').mockImplementationOnce((session, operations, options) =>
    edit(session, [...operations, { op: 'connect', from: h.node, to: 'missing', kind: 'derivation' }], options),
  )
  const expectedPath3: unknown = expect.any(String)
  await expect(
    h.editor.edit(session, { ...h.request, operation: 'first_frame', title: 'First' }),
  ).rejects.toMatchObject({ code: 'attachment', path: expectedPath3 })
  const document = await ctx.canvas.read(session)
  expect(document.nodes).toHaveLength(1)
  expect(document.nodes[0]!.versions).toHaveLength(1)
  expect((await readdir(directory)).filter(path => path.startsWith('local-'))).toHaveLength(1)
})

it('does not relabel an orphan made from older source bytes after a source file changes', async () => {
  const h = await fixture()
  const original = ctx.canvas.directoryOf.bind(ctx.canvas)
  const binding = vi.spyOn(ctx.canvas, 'directoryOf')
  h.exec.mockImplementationOnce(async (args) => {
    await writeFile(args.at(-1)!, 'completed')
    binding.mockReturnValue(join(directory, 'other'))
    return { stdout: '', stderr: '' }
  })
  await expect(h.editor.edit(session, h.request)).rejects.toMatchObject({ code: 'attachment' })
  binding.mockImplementation(original)
  await writeFile(h.path, 'source has changed')
  await h.editor.edit(session, h.request)
  expect(h.exec).toHaveBeenCalledTimes(2)
  expect((await readdir(directory)).filter(path => /^local-[a-f0-9]+\.wav$/u.test(path))).toHaveLength(2)
})

it('rejects invalid trim and fade intervals before running FFmpeg', async () => {
  const h = await fixture()
  await expect(
    h.editor.edit(session, { ...h.request, operation: 'audio_edit', inMs: 2500, outMs: 2000 }),
  ).rejects.toMatchObject({ code: 'input' })
  await expect(
    h.editor.edit(session, { ...h.request, operation: 'audio_edit', fadeOutMs: 9000 }),
  ).rejects.toMatchObject({ code: 'input' })
  expect(h.exec).not.toHaveBeenCalled()
  expect((await ctx.canvas.read(session)).nodes[0]!.versions).toHaveLength(1)
})

it('retains completed bytes after a project switch and attaches them on an explicit retry', async () => {
  const h = await fixture()
  const original = ctx.canvas.directoryOf.bind(ctx.canvas)
  const binding = vi.spyOn(ctx.canvas, 'directoryOf')
  h.exec.mockImplementationOnce(async (args) => {
    await writeFile(args.at(-1)!, 'completed')
    binding.mockReturnValue(join(directory, 'other'))
    return { stdout: '', stderr: '' }
  })
  const expectedPath4: unknown = expect.stringMatching(/local-.+\.wav$/u)
  await expect(h.editor.edit(session, h.request)).rejects.toMatchObject({
    code: 'attachment',
    path: expectedPath4,
  })
  expect((await readdir(directory)).filter(path => path.startsWith('local-'))).toHaveLength(1)
  binding.mockImplementation(original)
  const recovered = await h.editor.edit(session, h.request)
  expect(h.exec).toHaveBeenCalledTimes(1)
  expect((await ctx.canvas.read(session)).nodes[0]!.versions?.some(version => version.id === recovered.version)).toBe(
    true,
  )
})

it('preserves an adoption made while local processing runs', async () => {
  const h = await fixture()
  h.exec.mockImplementationOnce(async (args) => {
    await ctx.canvas.edit(session, [
      { op: 'append_version', node: h.node, version: { id: 'manual', path: h.path, origin: 'user', createdAt: 'now' } },
      { op: 'set_version', node: h.node, version: 'manual' },
    ])
    await writeFile(args.at(-1)!, 'completed')
    return { stdout: '', stderr: '' }
  })
  await h.editor.edit(session, h.request)
  expect((await ctx.canvas.read(session)).nodes[0]!.activeVersion).toBe('manual')
})

it('discards an interrupted temporary file without attaching a candidate', async () => {
  const h = await fixture()
  h.exec.mockImplementationOnce(async (args) => {
    await writeFile(args.at(-1)!, 'partial')
    h.controllers[0]!.abort()
    throw new Error('processing interrupted')
  })
  await expect(h.editor.edit(session, h.request)).rejects.toMatchObject({ code: 'processing' })
  expect((await readdir(directory)).some(path => path.startsWith('local-'))).toBe(false)
  expect((await ctx.canvas.read(session)).nodes[0]!.versions).toHaveLength(1)
})

it('refreshes a legacy tail using the last decoded frame and exact adopted source version', async () => {
  const h = await fixture('video')
  const result = await h.editor.edit(session, {
    scope: h.scope,
    node: h.node,
    version: h.version,
    operation: 'refresh_tail',
    title: 'Tail',
  })
  const document = await ctx.canvas.read(session)
  expect(document.nodes.find(node => node.id === h.node)?.tailOf).toEqual({
    node: result.node,
    version: result.version,
    sourceVersion: h.version,
  })
  const frame = document.nodes.find(node => node.id === result.node)!
  expect(frame.activeVersion).toBeUndefined()
  expect(frame.versions?.find(version => version.id === result.version)).toMatchObject({
    width: 180,
    height: 320,
    inputs: [{ node: h.node, version: h.version, path: h.path, role: 'source' }],
  })
  expect(h.probe).toHaveBeenCalledWith(h.path, expect.objectContaining({ countVideoFrames: true }))
  expect(h.exec.mock.calls[0]![0]).toContain('select=eq(n\\,40)')
})
