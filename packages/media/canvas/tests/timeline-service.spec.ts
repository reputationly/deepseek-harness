import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import CanvasService from '../src/index.ts'
import { parseCanvas } from '../src/document.ts'
import type { TimelineOperation, TimelineTrackId } from '../src/timeline-types.ts'
import type { CanvasChange, CanvasNodeId, EpisodeId, TimelineClipId, VersionId } from '../src/types.ts'

let ctx: Context, directory: string, session: Session, changes: CanvasChange[]
const node = brandString<CanvasNodeId>('n2')
const track = brandString<TimelineTrackId>('t1')
const media = brandString<CanvasNodeId>('n1')
const clip = brandString<TimelineClipId>('k1')
const spec = { width: 720, height: 1280, fps: 24 } as const
const initial: TimelineOperation[] = [
  { op: 'add_track', track: { id: track, kind: 'video', muted: false, volume: 1, clips: [] } },
  { op: 'add_clip', track, clip: { id: clip, startMs: 0, durationMs: 1000, source: { node: media, version: brandString<VersionId>('v1'), inMs: 0 } } },
]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-timeline-service-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService, { timelineHistoryLimit: 2 })
  session = Session.create(SessionId('timeline-editor'))
  changes = []
  ctx.on('canvas/change', (change) => { changes.push(change) })
  await writeFile(join(directory, 'clip.mp4'), 'local media fixture')
  await ctx.canvas.edit(session, [{ op: 'add', type: 'video', path: 'clip.mp4' }, { op: 'add', type: 'timeline' }], { baseRevision: 0 })
  changes.length = 0
})
afterEach(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })

it('persists a separate editing document and leaves script/canvas bytes unchanged', async () => {
  const canvasPath = join(directory, '.canvas', 'canvas.json')
  const before = await readFile(canvasPath, 'utf8')
  expect(await ctx.canvas.timeline(session, node)).toBeUndefined()
  const saved = await ctx.canvas.editTimeline(session, node, initial, 0, spec)
  expect(saved.document.revision).toBe(1)
  expect(await ctx.canvas.timeline(session, node)).toEqual(saved.document)
  expect(await readFile(canvasPath, 'utf8')).toBe(before)
  expect(changes).toMatchObject([{ revisions: { timelines: [{ node: 'n2', revision: 1 }] } }])
})

it('resolves recorded project-relative paths against the project instead of the application directory', async () => {
  const file = join(directory, '.canvas', 'canvas.json')
  const document = parseCanvas(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...document, nodes: document.nodes.map(node => node.type !== 'video' ? node
    : { ...node, versions: node.versions?.map(version => ({ ...version, path: 'clip.mp4' })) }) }))
  await expect(ctx.canvas.editTimeline(session, node, initial, 0, spec)).resolves.toMatchObject({ document: { revision: 1 } })
})

it('serializes competing manual and Agent writes; the loser cannot overwrite the winner', async () => {
  await ctx.canvas.editTimeline(session, node, initial, 0, spec)
  const writes = await Promise.allSettled([1000, 2000].map(startMs => ctx.canvas.editTimeline(session, node,
    [{ op: 'move_clip', clip, track, startMs }], 1, undefined)))
  expect(writes.filter(write => write.status === 'fulfilled')).toHaveLength(1)
  const rejected = writes.find(write => write.status === 'rejected')
  expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'canvas/conflict' } })
  const stored = await ctx.canvas.timeline(session, node)
  expect(stored?.revision).toBe(2)
  const winner = writes.findIndex(write => write.status === 'fulfilled')
  expect(stored?.tracks[0]?.clips[0]?.startMs).toBe([1000, 2000][winner])
  expect(changes).toHaveLength(2)
})

it('does not write or emit after an invalid later command', async () => {
  await ctx.canvas.editTimeline(session, node, initial, 0, spec)
  const path = join(directory, '.canvas', 'canvas.json.timelines', 'n2.json')
  const before = await readFile(path, 'utf8')
  await expect(ctx.canvas.editTimeline(session, node, [{ op: 'remove_clip', clip },
    { op: 'add_clip', track, clip: { id: clip, startMs: 0, durationMs: -1, source: { node: media, version: brandString<VersionId>('v1'), inMs: 0 } } }], 1, undefined))
    .rejects.toMatchObject({ code: 'canvas/invalid-input' })
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(changes).toHaveLength(1)
})

it.each(['v99', 'v_import_missing', 'local-missing'])('refuses unavailable source version %s before committing or notifying', async (version) => {
  await ctx.canvas.editTimeline(session, node, initial, 0, spec)
  await expect(ctx.canvas.editTimeline(session, node, [{ op: 'set_clip', clip,
    patch: { source: { node: media, version: brandString<VersionId>(version), inMs: 0 } } }], 1, undefined)).rejects.toThrow('unavailable')
  expect((await ctx.canvas.timeline(session, node))?.revision).toBe(1)
  expect(changes).toHaveLength(1)
})

it('keeps corrupt durable documents untouched and refuses path traversal', async () => {
  await ctx.canvas.editTimeline(session, node, initial, 0, spec)
  const path = join(directory, '.canvas', 'canvas.json.timelines', 'n2.json')
  await writeFile(path, '{broken')
  await expect(ctx.canvas.editTimeline(session, node, [], 1, undefined)).rejects.toMatchObject({ code: 'canvas/corrupt' })
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await expect(ctx.canvas.timeline(session, brandString<CanvasNodeId>('../n2'))).rejects.toThrow('invalid timeline node')
})

it('retains adopted versions beyond the history limit and refuses to delete their source', async () => {
  await ctx.canvas.editTimeline(session, node, initial, 0, spec)
  for (let i = 0; i < 10; i++) {
    const canvas = await ctx.canvas.read(session)
    await ctx.canvas.edit(session, [{ op: 'append_version', node: media,
      version: { path: join(directory, 'clip.mp4'), origin: 'agent', createdAt: new Date().toISOString() } }], { baseRevision: canvas.revision })
  }
  const beforeAdoption = await ctx.canvas.read(session)
  await ctx.canvas.edit(session, [{ op: 'set_version', node: media, version: 'v11' }], { baseRevision: beforeAdoption.revision })
  const canvas = await ctx.canvas.read(session)
  expect(canvas.nodes[0]?.activeVersion).toBe('v11')
  expect(canvas.nodes[0]?.versions?.some(version => version.id === 'v1')).toBe(true)
  expect((await ctx.canvas.timeline(session, node))?.tracks[0]?.clips[0]?.source?.version).toBe('v1')
  await expect(ctx.canvas.edit(session, [{ op: 'remove', node: media }], { baseRevision: canvas.revision })).rejects.toThrow('before deleting')
  expect((await ctx.canvas.read(session)).revision).toBe(canvas.revision)
  await ctx.canvas.editTimeline(session, node, [{ op: 'remove_clip', clip }], 1, undefined)
  await expect(ctx.canvas.edit(session, [{ op: 'remove', node: media }], { baseRevision: canvas.revision })).rejects.toThrow('history expire')
  // Revision one is retained until it leaves the configured two-revision window.
  await ctx.canvas.editTimeline(session, node, [{ op: 'set_spec', spec }], 2, undefined)
  await ctx.canvas.editTimeline(session, node, [{ op: 'set_spec', spec }], 3, undefined)
  await ctx.canvas.edit(session, [{ op: 'remove', node: media }], { baseRevision: canvas.revision })
  expect((await ctx.canvas.read(session)).nodes.some(node => node.id === media)).toBe(false)
})

it('lets the Agent and editor use the same revisioned document and removes tools on disposal', async () => {
  const call = async (name: string, args: unknown): Promise<{ text: string; error: boolean }> => {
    const result = await executeToolFixture(ctx, { name, arguments: args, callId: ToolCallId(name),
      signal: new AbortController().signal, agent: { id: session.id, session } as never })
    return { text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''), error: result.isError }
  }
  const scope = { node, directory, episode: 'e1' }
  const written = await call('timeline_edit', { ...scope, operations: initial, baseRevision: 0, spec })
  expect(written).toEqual({ text: '{"revision":1,"invalidated":[{"fromMs":0,"toMs":1000}]}', error: false })
  const manual = await ctx.canvas.editTimeline(session, node, [{ op: 'move_clip', clip, track, startMs: 2000 }], 1, undefined)
  expect(manual.document.revision).toBe(2)
  expect((await call('timeline_edit', { ...scope, operations: [{ op: 'remove_clip', clip }], baseRevision: 1 })).error).toBe(true)
  const result = await call('timeline_get', scope)
  expect(result.error).toBe(false)
  expect(JSON.parse(result.text)).toMatchObject({ revision: 2, document: { tracks: [{ clips: [{ startMs: 2000 }] }] } })
  expect((await call('timeline_edit', { ...scope, baseRevision: 2,
    operations: [{ op: 'set_clip', clip, patch: { unknown: true } }] })).error).toBe(true)
  expect((await ctx.canvas.timeline(session, node))?.revision).toBe(2)
  const registry = ctx.tools
  expect(registry.get('timeline_edit')).toBeDefined()
  const runtime = ctx.registry.get(CanvasService)
  if (runtime !== undefined) await Promise.all([...runtime.fibers].map(fiber => fiber.dispose()))
  expect(registry.get('timeline_edit')).toBeUndefined()
  expect(registry.get('timeline_get')).toBeUndefined()
})

it('reworks one approved shot without replacing pinned versions, manual edits, music, or subtitles', async () => {
  const second = brandString<TimelineClipId>('k2'), music = brandString<TimelineTrackId>('t2'), subtitles = brandString<TimelineTrackId>('t3')
  await writeFile(join(directory, 'bed.wav'), 'retained audio fixture')
  const added = await ctx.canvas.edit(session, [{ op: 'add', type: 'audio', path: 'bed.wav', ref: 'bed' }])
  await ctx.canvas.editTimeline(session, node, [...initial,
    { op: 'add_clip', track, clip: { id: second, startMs: 2000, durationMs: 1000, source: { node: media, version: brandString<VersionId>('v1'), inMs: 0 } } },
    { op: 'add_track', track: { id: music, kind: 'audio', volume: 0.4, muted: false, clips: [{ id: brandString<TimelineClipId>('k3'), startMs: 0, durationMs: 3000, source: { node: added.refs.bed!, version: brandString<VersionId>('v1'), inMs: 0 } }] } },
    { op: 'add_track', track: { id: subtitles, kind: 'text', volume: 1, muted: false, clips: [{ id: brandString<TimelineClipId>('k4'), startMs: 0, durationMs: 900, text: { content: 'Keep this reviewed caption', position: 'bottom', size: 32 } }] } },
  ], 0, spec)
  await ctx.canvas.editTimeline(session, node, [{ op: 'set_clip', clip: second, patch: { volume: 0.6 } }], 1, undefined)
  const reviewed = await ctx.canvas.timeline(session, node)
  const canvasBefore = await ctx.canvas.read(session)
  const adopted = canvasBefore.nodes[0]!.activeVersion
  const candidate = brandString<VersionId>('v2')
  await ctx.canvas.edit(session, [{ op: 'append_version', node: media, version: { id: candidate, path: join(directory, 'clip.mp4'), createdAt: 'now', origin: 'agent' } }], { baseRevision: canvasBefore.revision })
  expect((await ctx.canvas.read(session)).nodes[0]!.activeVersion).toBe(adopted)
  await ctx.canvas.edit(session, [{ op: 'set_version', node: media, version: candidate }])
  expect(await ctx.canvas.timeline(session, node)).toEqual(reviewed)
  const operation: TimelineOperation = { op: 'set_clip', clip, patch: { source: { node: media, version: candidate, inMs: 0 } } }
  await expect(ctx.canvas.editTimeline(session, node, [operation], 1, undefined)).rejects.toMatchObject({ code: 'canvas/conflict' })
  const saved = await ctx.canvas.editTimeline(session, node, [operation], reviewed!.revision, undefined)
  expect(saved.invalidated).toEqual([{ fromMs: 0, toMs: 1000 }])
  expect(saved.document.tracks[0]!.clips[0]!.source?.version).toBe(candidate)
  expect(saved.document.tracks[0]!.clips[1]).toEqual(reviewed!.tracks[0]!.clips[1])
  expect(saved.document.tracks.slice(1)).toEqual(reviewed!.tracks.slice(1))
  expect((await ctx.canvas.read(session)).nodes[0]!.versions?.some(version => version.id === adopted)).toBe(true)
})

it('refuses a draft addressed to another project or an absent episode before changing files', async () => {
  await ctx.canvas.editTimeline(session, node, initial, 0, spec)
  const file = join(directory, '.canvas', `canvas.json.timelines/${node}.json`)
  const before = await readFile(file, 'utf8')
  await expect(ctx.canvas.editTimeline(session, node, [{ op: 'remove_clip', clip }], 1, undefined,
    brandString<EpisodeId>('e1'), join(directory, 'other-project'))).rejects.toThrow('project changed')
  await expect(ctx.canvas.editTimeline(session, node, [{ op: 'remove_clip', clip }], 1, undefined,
    brandString<EpisodeId>('e2'), directory)).rejects.toThrow('does not exist')
  expect(await readFile(file, 'utf8')).toBe(before)
})

it('restores immutable history and persists multi-step undo and redo across fresh service instances', async () => {
  await ctx.canvas.editTimeline(session, node, initial, 0, spec)
  const canvas = await readFile(join(directory, '.canvas', 'canvas.json'), 'utf8')
  await ctx.canvas.editTimeline(session, node, [{ op: 'move_clip', clip, track, startMs: 1000 }], 1, undefined)
  const snapshot = join(directory, '.canvas', 'canvas.json.timelines/n2.json.history/1.json')
  const before = await readFile(snapshot, 'utf8')
  await ctx.canvas.editTimeline(session, node, [{ op: 'move_clip', clip, track, startMs: 2000 }], 2, undefined)
  const undo = await ctx.canvas.restoreTimeline(session, node, 2, 3, 'undo')
  expect(undo.document).toMatchObject({ revision: 4, history: { undo: 1, redo: 3 }, tracks: [{ clips: [{ startMs: 1000 }] }] })
  // Increase this test's retained window before the cursor reaches revision one.
  const runtime = ctx.registry.get(CanvasService)
  if (runtime === undefined) throw new Error('fixture canvas service is missing')
  await Promise.all([...runtime.fibers].map(fiber => fiber.dispose()))
  await ctx.plugin(CanvasService, { timelineHistoryLimit: 10 })
  const reopened = ctx.canvas
  const undoneAgain = await reopened.restoreTimeline(session, node, 1, 4, 'undo')
  expect(undoneAgain.document).toMatchObject({ revision: 5, history: { redo: 4 }, tracks: [{ clips: [{ startMs: 0 }] }] })
  const redone = await reopened.restoreTimeline(session, node, 4, 5, 'redo')
  expect(redone.document).toMatchObject({ revision: 6, history: { undo: 5, redo: 3 }, tracks: [{ clips: [{ startMs: 1000 }] }] })
  const redoneAgain = await reopened.restoreTimeline(session, node, 3, 6, 'redo')
  expect(redoneAgain.document).toMatchObject({ revision: 7, history: { undo: 6 }, tracks: [{ clips: [{ startMs: 2000 }] }] })
  const restored = await reopened.restoreTimeline(session, node, 1, 7, 'restore')
  expect(restored.document).toMatchObject({ revision: 8, history: { undo: 7 }, tracks: [{ clips: [{ startMs: 0 }] }] })
  expect(await readFile(snapshot, 'utf8')).toBe(before)
  expect(await readFile(join(directory, '.canvas', 'canvas.json'), 'utf8')).toBe(canvas)
})

it('refuses stale, unavailable, and incorrectly addressed history restores without overwriting the live file', async () => {
  await ctx.canvas.editTimeline(session, node, initial, 0, spec)
  await ctx.canvas.editTimeline(session, node, [{ op: 'move_clip', clip, track, startMs: 1000 }], 1, undefined)
  const path = join(directory, '.canvas', 'canvas.json.timelines/n2.json')
  const before = await readFile(path, 'utf8')
  await expect(ctx.canvas.restoreTimeline(session, node, 1, 1, 'restore')).rejects.toMatchObject({ code: 'canvas/conflict' })
  await expect(ctx.canvas.restoreTimeline(session, node, 99, 2, 'restore')).rejects.toMatchObject({ code: 'canvas/invalid-input' })
  await expect(ctx.canvas.restoreTimeline(session, node, 1, 2, 'redo')).rejects.toMatchObject({ code: 'canvas/invalid-input' })
  await expect(ctx.canvas.timelineHistory(session, node, brandString<EpisodeId>('e1'), join(directory, 'other'))).rejects.toThrow('project changed')
  expect(await readFile(path, 'utf8')).toBe(before)
  expect((await ctx.canvas.timelineHistory(session, node)).map(entry => entry.revision)).toEqual([2, 1])
})
