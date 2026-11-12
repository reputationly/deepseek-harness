import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import CanvasService, { CanvasCorruptError, CanvasInputError } from '../src/index.ts'
import { canvasFile } from '../src/store.ts'
import type { CanvasChange } from '../src/types.ts'

let directory: string
let ctx: Context
let session: Session
let changes: CanvasChange[]
let calls = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService)
  session = Session.create(SessionId('canvas-session'))
  changes = []
  ctx.on('canvas/change', (change) => { changes.push(change) })
  for (const name of ['a.png', 'b.png', 'clip.mp4', 'track.mp3']) await writeFile(join(directory, name), name)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${String(++calls)}`),
    name,
    arguments: args,
    agent: { id: session.id, session } as never,
  })
  return { text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''), isError: result.isError }
}

describe('CanvasService', () => {
  it('reads an empty canvas for a project without a canvas file and writes nothing', async () => {
    expect(await ctx.canvas.read(session)).toEqual({ version: 2, revision: 0, nextId: 1, nodes: [], edges: [] })
    await expect(readFile(canvasFile(directory))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists edits, resolves relative media paths, and announces each change once', async () => {
    const result = await ctx.canvas.edit(session, [
      { op: 'add', ref: 'a', type: 'image', path: 'a.png' },
      { op: 'add', type: 'image', path: 'missing.png' },
    ], { baseRevision: 0 })
    expect(result.skipped).toEqual([{ index: 1, op: 'add', reason: 'file missing.png does not exist' }])
    const stored = JSON.parse(await readFile(canvasFile(directory), 'utf8')) as { nodes: { versions: { path?: string }[] }[] }
    expect(stored.nodes.map(node => node.versions[0]?.path)).toEqual([join(directory, 'a.png')])
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ directory, episode: 'e1', revisions: { canvas: 1 } })
    const unchanged = await ctx.canvas.edit(session, [{ op: 'remove', node: 'n9' }], { baseRevision: result.revision })
    expect(unchanged.revision).toBe(1)
    expect(changes).toHaveLength(1)
  })

  it('applies concurrent edits one after another without losing either', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => ctx.canvas.edit(session, [{ op: 'add', type: 'text', text: `note ${String(index)}` }])))
    const document = await ctx.canvas.read(session)
    expect(document.nodes.map(node => node.id).sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'])
    expect(document.nextId).toBe(9)
  })

  it('refuses a canvas file that is not a valid document and leaves it untouched', async () => {
    await mkdir(join(directory, '.canvas'))
    await writeFile(canvasFile(directory), '{"version":1,"nextId":2,"nodes":[{"id":"n1"}],"edges":[]}')
    await expect(ctx.canvas.read(session)).rejects.toBeInstanceOf(CanvasCorruptError)
    await expect(ctx.canvas.edit(session, [{ op: 'add', type: 'text', text: 'x' }])).rejects.toBeInstanceOf(CanvasCorruptError)
    expect(await readFile(canvasFile(directory), 'utf8')).toBe('{"version":1,"nextId":2,"nodes":[{"id":"n1"}],"edges":[]}')
    const failure = await ctx.canvas.get(session).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect(failure).toMatchObject({ code: 'canvas/corrupt', details: { file: canvasFile(directory) } })
  })

  it('propagates unexpected file errors from media validation and remote reads', async () => {
    await symlink('loop', join(directory, 'loop'))
    await expect(ctx.canvas.edit(session, [{ op: 'add', type: 'image', path: 'loop' }]))
      .rejects.toMatchObject({ code: 'ELOOP' })

    await mkdir(join(directory, '.canvas'))
    await symlink('canvas.json', canvasFile(directory))
    await expect(ctx.canvas.get(session)).rejects.toMatchObject({ code: 'ELOOP' })
  })

  it('resolves image nodes and groups to image files for generation inputs', async () => {
    await ctx.canvas.edit(session, [
      { op: 'add', ref: 'a', type: 'image', path: 'a.png' },
      { op: 'add', ref: 'b', type: 'image', path: 'b.png' },
      { op: 'add', ref: 'clip', type: 'video', path: 'clip.mp4' },
      { op: 'add', ref: 'note', type: 'text', text: 'brief' },
      { op: 'group', ref: 'refs', nodes: ['a', 'b', 'clip'] },
      { op: 'group', ref: 'notes', nodes: ['note'] },
    ])
    const a = join(directory, 'a.png')
    const b = join(directory, 'b.png')
    expect(await ctx.canvas.resolveImages(session, ['g5'])).toEqual([a, b])
    expect(await ctx.canvas.resolveImages(session, ['n2', 'g5', 'n1'])).toEqual([b, a])
    // A group reads top to bottom: once the user drags the first image below the second, the second leads.
    await ctx.canvas.edit(session, [{ op: 'move', node: 'n1', x: 0, y: 2000 }])
    expect(await ctx.canvas.resolveImages(session, ['g5'])).toEqual([b, a])
    await expect(ctx.canvas.resolveImages(session, ['n3'])).rejects.toThrow(new CanvasInputError('canvas node n3 is a video node, not an image or a group'))
    await expect(ctx.canvas.resolveImages(session, ['g6'])).rejects.toThrow('canvas group g6 contains no image')
    await expect(ctx.canvas.resolveImages(session, ['n42'])).rejects.toThrow('canvas node n42 does not exist')
  })

  it('resolves media nodes to paths and rejects group, text, and pathless inputs', async () => {
    const grouped = await ctx.canvas.edit(session, [
      { op: 'add', type: 'image', path: 'a.png' },
      { op: 'add', type: 'video', path: 'clip.mp4' },
      { op: 'add', type: 'audio', path: 'track.mp3' },
      { op: 'add', type: 'text', text: 'brief' },
      { op: 'add', type: 'audio' },
      { op: 'group', ref: 'media', nodes: ['n1', 'n2'] },
    ])
    expect(await ctx.canvas.resolveMedia(session, ['n1', 'n2', 'n3'])).toEqual([
      join(directory, 'a.png'), join(directory, 'clip.mp4'), join(directory, 'track.mp3'),
    ])
    const groupId = grouped.refs.media
    if (groupId === undefined) throw new Error('media group fixture did not create a group id')
    await expect(ctx.canvas.resolveMedia(session, [groupId])).rejects.toThrow(`canvas node ${groupId} is a group node, not a media node`)
    await expect(ctx.canvas.resolveMedia(session, ['n4'])).rejects.toThrow('canvas node n4 is a text node, not a media node')
    const document = await ctx.canvas.read(session)
    await writeFile(canvasFile(directory), JSON.stringify({
      ...document,
      nodes: [...document.nodes, { id: 'n5', type: 'audio', title: 'Pathless', x: 0, y: 0, width: 320, height: 180 }],
    }))
    await expect(ctx.canvas.resolveMedia(session, ['n5'])).rejects.toThrow('canvas media node n5 has no path')
    await expect(ctx.canvas.resolveMedia(session, ['n42'])).rejects.toThrow('canvas node n42 does not exist')
  })

  it('serves the Remote view and applies user operations', async () => {
    await ctx.canvas.apply(session, [{ op: 'add', type: 'text', text: 'hello' }, { op: 'move', node: 'n1', x: 40, y: 60 }], 0)
    const view = await ctx.canvas.get(session)
    expect(view.directory).toBe(directory)
    expect(view.episode).toEqual({ id: 'e1', title: 'Canvas' })
    expect(view.revisions).toEqual({ canvas: 1 })
    expect(view.document.nodes).toMatchObject([{ id: 'n1', x: 40, y: 60, placed: true }])
  })
})

describe('canvas tools', () => {
  it('shows the model one schema per tool', () => {
    const schemas = ctx.tools.schemas().filter(schema => schema.name.startsWith('canvas_'))
    expect(schemas).toMatchSnapshot()
  })

  it('builds a connected, grouped canvas in one call and reads it back', async () => {
    const edit = await call('canvas_edit', {
      baseRevision: 0,
      operations: [
        { op: 'add', ref: 'brief', type: 'text', title: 'Brief', text: 'x'.repeat(200) },
        { op: 'add', ref: 'a', type: 'image', path: 'a.png' },
        { op: 'add', ref: 'b', type: 'image', path: 'b.png' },
        { op: 'connect', from: 'brief', to: 'a' },
        { op: 'connect', from: 'brief', to: 'ghost' },
        { op: 'group', ref: 'refs', title: 'References', nodes: ['a', 'b'] },
      ],
    })
    expect(edit.isError).toBe(false)
    expect(edit.text).toBe('Revision 1.\nCreated n1 (brief), n2 (a), n3 (b), g4 (refs).\nSkipped operation 4 (connect): node ghost does not exist.')
    const listing = await call('canvas_get', {})
    expect(listing.text.replaceAll(directory, '<project>')).toMatchSnapshot()
    const one = await call('canvas_get', { nodes: ['n1', 'n7'] })
    expect(one.text).toContain(`text="${'x'.repeat(200)}"`)
    expect(one.text).toContain('Not on the canvas: n7')
  })

  it('reports an empty canvas, a no-op edit, and a malformed operation', async () => {
    expect((await call('canvas_get', {})).text).toContain('The canvas is empty.')
    await call('canvas_edit', { baseRevision: 0, operations: [{ op: 'add', type: 'text', text: 'a' }] })
    const noop = await call('canvas_edit', { baseRevision: 1, operations: [{ op: 'remove', node: 'n9' }] })
    expect(noop.text).toBe('Revision 1.\nSkipped operation 0 (remove): node n9 does not exist.')
    const malformed = await call('canvas_edit', { baseRevision: 1, operations: [{ op: 'connect', from: 'n1' }] })
    expect(malformed.isError).toBe(true)
    expect(malformed.text).toContain('operations[0] (connect) needs to')
  })
})
