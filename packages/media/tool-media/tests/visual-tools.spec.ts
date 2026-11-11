import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import CanvasService from '@deepseek-ai/dsh-canvas'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerVisualTools } from '../src/visual-tools.ts'

const PNG = Buffer.from('iVBORw0KGgo=', 'base64')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let directory: string
let ctx: Context
let session: Session
let fetchSpy: MockInstance<typeof fetch>
let calls = 0
let written = 0

async function setup(withCanvas: boolean): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  provideWorkingDirectoryFixture(ctx, directory)
  if (withCanvas) await ctx.plugin(CanvasService)
  registerVisualTools(ctx, {
    request: signal => Promise.resolve({ baseURL: 'https://gateway.example/v1', apiKey: 'sk-test', signal }),
    catalog: undefined,
    imageModel: 'image-model',
    videoModel: 'video-model',
    videoDefaultDuration: 5,
    taskTimeoutMs: 5_000,
    pollIntervalMs: 1,
    write: async (prefix, _contentType, bytes) => {
      const path = join(directory, `${prefix}-${String(++written)}.out`)
      await writeFile(path, bytes)
      return path
    },
    canvas: () => ctx.get('canvas'),
  })
}

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

function requestBody(index: number): Record<string, unknown> {
  return JSON.parse(fetchSpy.mock.calls[index]![1]!.body as string) as Record<string, unknown>
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-media-canvas-'))
  session = Session.create(SessionId('media-session'))
  written = 0
  for (const name of ['a.png', 'b.png', 'c.png']) await writeFile(join(directory, name), Buffer.concat([PNG, Buffer.from(name)]))
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(async () => {
  fetchSpy.mockRestore()
  await rm(directory, { recursive: true, force: true })
})

describe('visual tools on a canvas', () => {
  it('sends every image of a referenced group to the edits endpoint and places the result with a derivation edge', async () => {
    await setup(true)
    await ctx.canvas.edit(session, [
      { op: 'add', ref: 'a', type: 'image', path: 'a.png' },
      { op: 'add', ref: 'b', type: 'image', path: 'b.png' },
      { op: 'add', ref: 'note', type: 'text', text: 'not an image' },
      { op: 'group', ref: 'refs', title: 'References', nodes: ['a', 'b', 'note'] },
    ])
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))

    const result = await call('generate_image', { prompt: 'merge the two cats', referenceNodes: ['g4'] })

    expect(result).toEqual({ isError: false, text: `Wrote ${join(directory, 'image-1.out')}. It is canvas node n5.` })
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://gateway.example/v1/images/edits')
    const sent = requestBody(0)
    expect(sent).toMatchObject({ model: 'image-model', prompt: 'merge the two cats' })
    const images = sent.images as string[]
    expect(images).toHaveLength(2)
    for (const [index, name] of ['a.png', 'b.png'].entries()) {
      expect(Buffer.from(images[index]!.split(',')[1]!, 'base64').equals(await readFile(join(directory, name)))).toBe(true)
    }
    const document = await ctx.canvas.read(session)
    expect(document.nodes.find(node => node.id === 'n5')).toMatchObject({
      type: 'image', path: join(directory, 'image-1.out'), prompt: 'merge the two cats', model: 'image-model',
    })
    expect(document.edges).toEqual([{ id: 'g4->n5', source: 'g4', target: 'n5', kind: 'derivation' }])
  })

  it('links a result to the canvas nodes of the files it was made from', async () => {
    await setup(true)
    await ctx.canvas.edit(session, [{ op: 'add', type: 'image', path: 'a.png' }])
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    await call('generate_image', { prompt: 'repaint', referenceImages: [join(directory, 'a.png'), join(directory, 'c.png')] })
    expect((await ctx.canvas.read(session)).edges).toEqual([{ id: 'n1->n2', source: 'n1', target: 'n2', kind: 'derivation' }])
  })

  it('uses canvas nodes as video frames and references and places the video', async () => {
    await setup(true)
    await ctx.canvas.edit(session, [
      { op: 'add', type: 'image', path: 'a.png' },
      { op: 'add', type: 'image', path: 'b.png' },
    ])
    fetchSpy
      .mockResolvedValueOnce(json({ id: 'task-1', status: 'queued' }))
      .mockResolvedValueOnce(json({ id: 'task-1', status: 'completed', url: 'https://cdn.example/out.mp4' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }))

    const result = await call('generate_video', { prompt: 'cat walks', firstFrameNode: 'n1', lastFrameNode: 'n2', duration: '5' })

    expect(result).toEqual({ isError: false, text: `Wrote ${join(directory, 'video-1.out')}. It is canvas node n3.` })
    expect(JSON.stringify(requestBody(0))).toContain((await readFile(join(directory, 'a.png'))).toString('base64'))
    const document = await ctx.canvas.read(session)
    expect(document.nodes.find(node => node.id === 'n3')).toMatchObject({ type: 'video', model: 'video-model' })
    expect(document.edges.map(edge => edge.id)).toEqual(['n1->n3', 'n2->n3'])
  })

  it('fails before any gateway request when a referenced node cannot be an image input', async () => {
    await setup(true)
    await ctx.canvas.edit(session, [
      { op: 'add', type: 'text', text: 'brief' },
      { op: 'add', type: 'image', path: 'a.png' },
      { op: 'add', type: 'image', path: 'b.png' },
      { op: 'group', nodes: ['n2', 'n3'] },
    ])
    const text = await call('generate_image', { prompt: 'x', referenceNodes: ['n1'] })
    expect(text).toMatchObject({ isError: true })
    expect(text.text).toContain('generate_image: canvas node n1 is a text node, not an image or a group')
    const frame = await call('generate_video', { prompt: 'x', firstFrameNode: 'g4' })
    expect(frame.text).toContain('generate_video: canvas node g4 is not a single image; a frame needs one image node')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((await ctx.canvas.read(session)).nodes).toHaveLength(4)
  })

  it('places nothing when generation fails', async () => {
    await setup(true)
    fetchSpy.mockResolvedValueOnce(json({ error: { message: 'insufficient quota' } }, 402))
    const result = await call('generate_image', { prompt: 'a cat' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('insufficient quota')
    expect((await ctx.canvas.read(session)).nodes).toEqual([])
  })

  it('keeps writing files where no canvas is mounted and refuses canvas references there', async () => {
    await setup(false)
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    expect(await call('generate_image', { prompt: 'a cat' })).toEqual({ isError: false, text: `Wrote ${join(directory, 'image-1.out')}.` })
    const refused = await call('generate_image', { prompt: 'a cat', referenceNodes: ['n1'] })
    expect(refused.text).toContain('no canvas is available here; pass image files instead of canvas nodes')
  })

  it('persists the generated artifact path as structured presentation metadata', async () => {
    await setup(false)
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId(`call-${String(++calls)}`),
      name: 'generate_image',
      arguments: { prompt: 'a cat' },
      agent: { id: session.id, session } as never,
    })
    expect(result.meta).toMatchObject({
      status: 'done',
      model: 'image-model',
      path: join(directory, 'image-1.out'),
    })
  })

  it('reports a written file that could not be placed', async () => {
    await setup(true)
    await writeFile(join(directory, '.canvas'), 'not a directory')
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    const result = await call('generate_image', { prompt: 'a cat' })
    expect(result.isError).toBe(false)
    expect(result.text).toMatch(/^Wrote .*image-1\.out\. It was not placed on the canvas: /)
  })
})
