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
import { CatalogSource } from '../src/catalog.ts'
import { placeMediaArtifact, registerVisualTools } from '../src/visual-tools.ts'

const PNG = Buffer.from('iVBORw0KGgo=', 'base64')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let directory: string
let ctx: Context
let session: Session
let fetchSpy: MockInstance<typeof fetch>
let calls = 0
let written = 0
let removeWrittenFile = false

async function setup(withCanvas: boolean, catalog?: CatalogSource): Promise<void> {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  provideWorkingDirectoryFixture(ctx, directory)
  if (withCanvas) await ctx.plugin(CanvasService)
  registerVisualTools(ctx, {
    request: signal => Promise.resolve({ baseURL: 'https://gateway.example/v1', apiKey: 'sk-test', signal }),
    catalog,
    imageModel: 'image-model',
    videoModel: 'video-model',
    videoDefaultDuration: 5,
    taskTimeoutMs: 5_000,
    pollIntervalMs: 1,
    write: async (prefix, _contentType, bytes) => {
      const path = join(directory, `${prefix}-${String(++written)}.out`)
      await writeFile(path, bytes)
      if (removeWrittenFile) await rm(path)
      return path
    },
    canvas: () => ctx.get('canvas'),
  })
}

async function call(name: string, args: unknown, signal = new AbortController().signal): Promise<{ text: string; isError: boolean }> {
  const result = await executeToolFixture(ctx, {
    signal,
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
  removeWrittenFile = false
  for (const name of ['a.png', 'b.png', 'c.png']) await writeFile(join(directory, name), Buffer.concat([PNG, Buffer.from(name)]))
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(async () => {
  fetchSpy.mockRestore()
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
})

describe('visual tools on a canvas', () => {
  it('uses explicit, basename, and shortened prompt titles for placed media', async () => {
    await setup(true)
    const explicit = await placeMediaArtifact(ctx.canvas, session, {
      type: 'image', kind: 'image', path: join(directory, 'a.png'), title: 'Chosen title',
    })
    const basename = await placeMediaArtifact(ctx.canvas, session, {
      type: 'audio', kind: 'speech', path: join(directory, 'b.png'),
    })
    const prompt = await placeMediaArtifact(ctx.canvas, session, {
      type: 'video', kind: 'video', path: join(directory, 'c.png'), prompt: 'x'.repeat(45),
    })
    expect([explicit, basename, prompt]).toEqual([{ nodeId: 'n1' }, { nodeId: 'n2' }, { nodeId: 'n3' }])
    expect((await ctx.canvas.read(session)).nodes.map(node => node.title)).toEqual([
      'Chosen title', 'b.png', `${'x'.repeat(40)}…`,
    ])
  })

  it('reports a canvas edit that neither creates nor skips a node', async () => {
    await setup(true)
    const emptyResult = await ctx.canvas.edit(session, [])
    vi.spyOn(ctx.canvas, 'edit').mockResolvedValue(emptyResult)
    expect(await placeMediaArtifact(ctx.canvas, session, {
      type: 'image', kind: 'image', path: join(directory, 'a.png'),
    })).toEqual({ canvasError: 'the node was not created' })
  })

  it('renders schema-valid optional image result fields without assuming generation output', async () => {
    await setup(false)
    const tool = ctx.tools.get('generate_image')
    if (tool === undefined) throw new Error('generate_image was not registered')
    expect(tool.output.render({}, { status: 'done', model: 'image-model' })).toEqual([
      { type: 'text', text: 'Wrote .' },
    ])
    const noChoices = tool.output.render({}, { status: 'needs_choice', model: 'image-model' })
    const noChoicesText = noChoices.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(noChoicesText).toContain('Nothing was generated yet.')
    const choice = tool.output.render({}, {
      status: 'needs_choice',
      model: 'image-model',
      choices: [{ id: 'ratio', title: 'Ratio', options: ['1:1'], recommended: '1:1' }],
    })
    const choiceText = choice.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(choiceText).toContain('- ratio (Ratio): options 1:1; recommended 1:1.')
    expect(choiceText).not.toContain('The user asked for')
  })

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
      type: 'image',
      versions: [{ path: join(directory, 'image-1.out'), prompt: 'merge the two cats', model: 'image-model' }],
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

  it('uses the image MIME fallback for unknown reference extensions', async () => {
    await setup(false)
    const path = join(directory, 'reference.unknown')
    await writeFile(path, PNG)
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    await call('generate_image', { prompt: 'repaint', referenceImages: [path] })
    expect(requestBody(0).images).toEqual([`data:image/png;base64,${PNG.toString('base64')}`])
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
    expect(document.nodes.find(node => node.id === 'n3')).toMatchObject({
      type: 'video', versions: [{ model: 'video-model' }],
    })
    expect(document.edges.map(edge => edge.id)).toEqual(['n1->n3', 'n2->n3'])
  })

  it('uses local frame files and forwards stated video parameters', async () => {
    await setup(false)
    fetchSpy
      .mockResolvedValueOnce(json({ id: 'task-local-frame' }))
      .mockResolvedValueOnce(json({ status: 'completed', url: 'https://cdn.example/local.mp4' }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'content-type': 'video/mp4' } }))
    const result = await call('generate_video', {
      prompt: 'a cat runs',
      firstFrame: join(directory, 'a.png'),
      aspectRatio: '16:9',
      resolution: '768P',
      duration: '5',
      audio: false,
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(requestBody(0))).toContain((await readFile(join(directory, 'a.png'))).toString('base64'))
    expect(result.text).toContain('video-1.out')
  })

  it('sends computed image sizes and asks before generating an unsettled video request', async () => {
    const catalog = new CatalogSource({
      baseURL: 'https://gateway.example/v1',
      cacheFile: join(directory, 'ready-catalog.json'),
      fetch: async () => json({
        version: 'v1',
        capabilities: [{
          id: 'image',
          operation: 'generate_image',
          model: 'image-model',
          taskTypes: ['t2i'],
          paramSchema: { properties: {
            aspect_ratio: { enum: ['1:1', '16:9'], default: '1:1', title: 'Ratio' },
            resolution: { enum: ['1K', '2K'], default: '2K', title: 'Resolution' },
          } },
        }],
      }),
    })
    await setup(false, catalog)
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    expect((await call('generate_image', {
      prompt: 'a cat', aspectRatio: '16:9', resolution: '2K',
    })).isError).toBe(false)
    expect(requestBody(0)).toMatchObject({ size: '2560x1440' })

    await ctx.fiber.dispose()
    fetchSpy.mockClear()
    const videoCatalog = new CatalogSource({
      baseURL: 'https://gateway.example/v1',
      cacheFile: join(directory, 'video-choice-catalog.json'),
      fetch: async () => json({
        version: 'v1',
        capabilities: [{
          id: 'video',
          operation: 'generate_video',
          model: 'video-model',
          taskTypes: ['t2v'],
          default: true,
          paramSchema: { properties: {
            ratio: { enum: ['adaptive', '16:9'], default: '16:9', title: 'Ratio' },
            resolution: { enum: ['768P', '2K'], default: '768P', title: 'Resolution' },
          } },
        }],
      }),
    })
    await setup(false, videoCatalog)
    const choice = await call('generate_video', { prompt: 'a cat runs' })
    expect(choice.isError).toBe(false)
    expect(choice.text).toContain('Nothing was generated yet.')
    expect(choice.text).toContain('- ratio')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects image and video generation when the key has no matching capability', async () => {
    const emptyCatalog = new CatalogSource({
      baseURL: 'https://gateway.example/v1',
      cacheFile: join(directory, 'empty-catalog.json'),
      fetch: async () => json({ version: 'empty', capabilities: [] }),
    })
    await setup(true, emptyCatalog)
    expect((await call('generate_image', { prompt: 'a cat' })).text).toContain('no image model is available')
    expect((await call('generate_video', { prompt: 'a cat walks' })).text).toContain('no video model is available')
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

  it('wraps non-Error canvas lookup failures at the tool boundary', async () => {
    await setup(true)
    vi.spyOn(ctx.canvas, 'resolveImages').mockRejectedValue('canvas read failed')
    const result = await call('generate_image', { prompt: 'x', referenceNodes: ['n1'] })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('generate_image: canvas read failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('asks for catalog choices, falls back on catalog failures, and propagates cancellation', async () => {
    const capabilities = [{
      id: 'image', operation: 'generate_image', model: 'image-model', taskTypes: ['t2i'], default: true,
      paramSchema: { properties: {
        aspect_ratio: { enum: ['1:1', '16:9'], default: '1:1', title: 'Ratio' },
        resolution: { enum: ['1K', '2K'], default: '2K', title: 'Resolution' },
      } },
    }]
    const choiceCatalog = new CatalogSource({
      baseURL: 'https://gateway.example/v1',
      cacheFile: join(directory, 'catalog.json'),
      fetch: async () => json({ version: 'v1', capabilities }),
    })
    await setup(false, choiceCatalog)
    const choice = await call('generate_image', { prompt: 'a cat', aspectRatio: '4:3' })
    expect(choice.text).toContain('Nothing was generated yet')
    expect(choice.text).toContain('The user asked for "4:3", which is not supported.')
    expect(fetchSpy).not.toHaveBeenCalled()

    await ctx.fiber.dispose()
    const fallbackCatalog = new CatalogSource({
      baseURL: 'https://gateway.example/v1',
      cacheFile: join(directory, 'fallback.json'),
      fetch: async () => { throw new Error('catalog offline') },
    })
    await setup(false, fallbackCatalog)
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    expect((await call('generate_image', { prompt: 'a cat' })).isError).toBe(false)

    await ctx.fiber.dispose()
    const controller = new AbortController()
    const abortingCatalog = new CatalogSource({
      baseURL: 'https://gateway.example/v1',
      cacheFile: join(directory, 'aborted.json'),
      fetch: async () => {
        controller.abort('catalog cancelled')
        throw new Error('catalog request aborted')
      },
    })
    await setup(false, abortingCatalog)
    const aborted = await call('generate_image', { prompt: 'a cat' }, controller.signal)
    expect(aborted.isError).toBe(true)
    expect(aborted.text).toContain('catalog request aborted')
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

  it('reports a skipped canvas add when a generated file disappears before placement', async () => {
    await setup(true)
    removeWrittenFile = true
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    const result = await call('generate_image', { prompt: 'a cat' })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('It was not placed on the canvas: file ')
  })

  it('contains non-Error failures while placing a generated artifact', async () => {
    await setup(true)
    vi.spyOn(ctx.canvas, 'edit').mockRejectedValue('canvas write failed')
    fetchSpy.mockResolvedValueOnce(json({ data: [{ url: `data:image/png;base64,${PNG.toString('base64')}` }] }))
    const result = await call('generate_image', { prompt: 'a cat' })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('It was not placed on the canvas: canvas write failed')
  })
})
