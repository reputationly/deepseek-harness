import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import CanvasService from '../src/index.ts'

let directory: string
let ctx: Context
let session: Session
let calls = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-tools-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService)
  session = Session.create(SessionId('canvas-tools-session'))
  for (const name of ['a.png', 'b.png', 'v.mp4', 'voice.mp3']) await writeFile(join(directory, name), name)
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

/** Revision the canvas currently holds. */
async function revision(): Promise<number> {
  return (await ctx.canvas.read(session)).revision
}

/** Apply one operation list through the tool and return its text. */
async function edit(operations: unknown[], baseRevision?: number): Promise<string> {
  return (await call('canvas_edit', { baseRevision: baseRevision ?? await revision(), operations })).text
}

const shot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 's1', title: 'shot', shotSize: 'close', visual: 'a street', motion: 'walking', camera: 'static',
  durationSec: 3, characters: ['c1'], scene: 'l1', props: ['p1'],
  dialogue: [{ id: 'd1', speaker: 'c1', line: 'hello' }], sfx: 'rain', negative: 'blur',
  ...overrides,
})

describe('canvas_edit operations', () => {
  it('maps every operation form, minimal and complete', async () => {
    // add: minimal fields, then the complete form with prompt, model, shots, bible, group.
    expect(await edit([{ op: 'add', type: 'text', text: 'brief' }])).toContain('Created n1')
    expect(await edit([{ op: 'add', type: 'image', path: 'a.png', prompt: 'a cat', genKind: 'image', model: 'qwen', bible: 'c1' }]))
      .toContain('Created n2')
    expect(await edit([{ op: 'group', title: 'Group', nodes: ['n1', 'n2'] }])).toContain('Created g3')
    expect(await edit([{ op: 'add', type: 'text', text: 'member', group: 'g3' }])).toContain('Created n4')
    expect(await edit([{ op: 'add', type: 'storyboard', shots: [shot()] }])).toContain('Created n5')
    const { id: _unusedId, ...withoutId } = shot()
    expect(await edit([{ op: 'add', type: 'storyboard', shots: [withoutId] }])).toContain('Created n6')
    expect(await edit([{ op: 'insert_shot', node: 'n6', shots: [withoutId] }])).toContain('Revision')

    // update: title only, then text and path.
    expect(await edit([{ op: 'update', node: 'n1', title: 'Brief' }])).toContain('Revision')
    expect(await edit([{ op: 'update', node: 'n1', text: 'new body' }])).toContain('Revision')
    expect(await edit([{ op: 'update', node: 'n2', path: 'b.png' }])).toContain('Revision')

    // set_gen: prompt only, then parameters with model and kind and a cleared key.
    expect(await edit([{ op: 'set_gen', node: 'n2', prompt: 'a dog' }])).toContain('Revision')
    expect(await edit([{
      op: 'set_gen', node: 'n2', prompt: 'a cat', model: 'm2', genKind: 'image', params: { ratio: '9:16', quality: null },
    }])).toContain('Revision')
    expect(await edit([{ op: 'set_gen', node: 'n2' }])).toContain('Revision')

    // text and shots.
    expect(await edit([{ op: 'set_text', node: 'n1', text: 'v2' }])).toContain('Revision')
    expect(await edit([{ op: 'set_shots', node: 'n5', shots: [shot(), shot({ id: 's2' })] }])).toContain('Revision')
    expect(await edit([{ op: 'update_shot', node: 'n5', shot: 's1', patch: { shotSize: 'wide' } }])).toContain('Revision')
    expect(await edit([{ op: 'update_shot', node: 'n5', shot: 's1' }])).toContain('Revision')
    const { id: _ignored, ...inserted } = shot()
    expect(await edit([{ op: 'insert_shot', node: 'n5', shots: [inserted] }])).toContain('Revision')
    expect(await edit([{ op: 'insert_shot', node: 'n5', after: 's1', shots: [inserted] }])).toContain('Revision')
    expect(await edit([{ op: 'move_shot', node: 'n5', shot: 's2' }])).toContain('Revision')
    expect(await edit([{ op: 'move_shot', node: 'n5', shot: 's2', after: 's1' }])).toContain('Revision')
    expect(await edit([{ op: 'remove_shot', node: 'n5', shot: 's1' }])).toContain('Revision')

    // versions.
    expect(await edit([{ op: 'set_version', node: 'n1', version: 'v1' }])).toContain('Revision')

    // edges.
    expect(await edit([{ op: 'connect', from: 'n2', to: 'n5' }])).toContain('Revision')
    expect(await edit([{ op: 'connect', from: 'n1', to: 'n5', role: 'prompt', order: 3 }])).toContain('Revision')
    expect(await edit([{ op: 'reorder_refs', node: 'n5', sources: ['n2'] }])).toContain('Revision')
    expect(await edit([{ op: 'disconnect', from: 'n1', to: 'n5', role: 'prompt' }])).toContain('Revision')
    expect(await edit([{ op: 'disconnect', from: 'n2', to: 'n5' }])).toContain('Revision')

    // group dissolution and removal.
    expect(await edit([{ op: 'ungroup', node: 'g3' }])).toContain('Revision')
    expect(await edit([{ op: 'remove', node: 'n6' }])).toContain('Revision')
  })

  it('maps a shot without optional fields', async () => {
    expect(await edit([{
      op: 'add',
      type: 'storyboard',
      shots: [{
        title: 'bare', shotSize: 'medium', visual: '', motion: '', camera: '', durationSec: 2,
        dialogue: [{ line: 'narration' }, { line: 'more', speaker: 'c1', id: 'd9' }],
      }],
    }])).toContain('Created n1')
    const document = await ctx.canvas.read(session)
    const shots = document.nodes[0]?.versions?.[0]?.shots
    expect(shots?.[0]?.id).toBe('s1')
    expect(shots?.[0]?.characters).toEqual([])
    expect(shots?.[0]?.props).toEqual([])
    expect(shots?.[0]?.scene).toBeUndefined()
    expect(shots?.[0]?.dialogue.map(line => line.id)).toEqual(['d1', 'd9'])
    expect(shots?.[0]?.dialogue[0]?.speaker).toEqual({ kind: 'narrator' })
  })

  it('reports malformed operations instead of mapping them', async () => {
    const missing = await call('canvas_edit', { baseRevision: 0, operations: [{ op: 'add' }] })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('needs type')
    const unknown = await call('canvas_edit', { baseRevision: 0, operations: [{ op: 'nope' }] })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('invalid')
  })

  it('echoes skipped operations and the new revision', async () => {
    expect(await edit([{ op: 'remove', node: 'n9' }])).toContain('Skipped operation 0 (remove): node n9 does not exist.')
  })
})

describe('canvas_get rendering', () => {
  it('renders every node field, edges, groups, and missing ids', async () => {
    await edit([
      { op: 'add', ref: 'ref', type: 'image', path: 'a.png', prompt: 'a cat', genKind: 'image', model: 'qwen', bible: 'c1' },
      { op: 'add', type: 'text', text: 'brief' },
      { op: 'add', type: 'storyboard', shots: [shot()] },
      { op: 'group', title: 'Refs', nodes: ['n1'] },
      { op: 'connect', from: 'n2', to: 'n3' },
      { op: 'connect', from: 'n1', to: 'n3', role: 'ref', order: 0 },
    ])
    await ctx.canvas.edit(session, [{ op: 'set_version', node: 'n1', version: 'v1' }], { baseRevision: await revision() })
    const listed = await call('canvas_get', { nodes: ['n1', 'n3', 'n9'] })
    expect(listed.text).toContain('group=g4')
    expect(listed.text).toContain('bible=c1')
    expect(listed.text).toContain('shots=1')
    expect(listed.text).toContain('model=qwen')
    expect(listed.text).toContain('path=')
    expect(listed.text).toContain('inputs=prompt n2')
    expect(listed.text).toContain('ref n1')
    expect(listed.text).toContain('n2->n3:prompt')
    expect(listed.text).toContain('Not on the canvas: n9')
  })

  it('reports versions, status, stale and input-changed markers', async () => {
    await edit([{ op: 'add', type: 'image', path: 'a.png' }, { op: 'add', type: 'text', text: 'body' }])
    await edit([{ op: 'update', node: 'n2', text: 'body 2' }])
    const document = await ctx.canvas.read(session)
    const patched = {
      ...document,
      nodes: document.nodes.map(node => node.id === 'n1'
        ? { ...node, stale: true, inputChanged: true, status: { state: 'running' as const, jobId: 'media-1' as never, at: 'now' } }
        : node),
    }
    await writeFile(join(directory, '.canvas', 'canvas.json'), JSON.stringify(patched))
    const listed = await call('canvas_get', {})
    expect(listed.text).toContain('status=running')
    expect(listed.text).toContain('stale')
    expect(listed.text).toContain('input-changed')
    expect(listed.text).toContain('versions=2')
  })

  it('includes only the files the caller asks for', async () => {
    await ctx.canvas.createProject(session, {
      format: 'free', title: 'Free', spec: { aspect: '16:9', resolution: '1080p', fps: 30 },
    })
    expect((await call('canvas_get', { include: ['project'] })).text).toContain('Project: ')
    expect((await call('canvas_get', { include: ['project'] })).text).not.toContain('Bible: ')
    expect((await call('canvas_get', { include: ['bible'] })).text).toContain('Bible: ')
    expect((await call('canvas_get', { include: ['bible'] })).text).not.toContain('Project: ')
  })
})

describe('studio tools', () => {
  it('creates a project and refuses a second one', async () => {
    const created = await call('studio_project_create', {
      format: 'mv', title: 'Song', aspect: '16:9', resolution: '1080p', fps: 24,
    })
    expect(created.text).toContain('Project "Song" (mv) created with 1 episode(s)')
    const again = await call('studio_project_create', {
      format: 'mv', title: 'Song', aspect: '16:9', resolution: '1080p', fps: 24,
    })
    expect(again.isError).toBe(true)
    expect(again.text).toContain('already has project.json')
  })

  it('creates and switches episodes', async () => {
    await call('studio_project_create', { format: 'drama', title: 'Rain', aspect: '9:16', resolution: '1080p', fps: 30 })
    expect((await call('studio_episode_create', { title: '第二集' })).text).toContain('Episode e2')
    expect((await call('studio_episode_use', { episode: 'e2' })).text).toContain('now edits that episode')
    const missing = await call('studio_episode_use', { episode: 'e9' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('does not exist')
  })

  it('updates the bible with and without optional fields', async () => {
    expect((await call('studio_bible_update', { logline: 'rain' })).text).toContain('Bible saved at revision 1 with 0 entries')
    const full = await call('studio_bible_update', {
      logline: 'rain',
      style: { visual: 'noir', palette: 'blue', aspect: '9:16', director: 'x', genre: 'y', tone: 'z' },
      upsert: [{
        id: 'c1', kind: 'character', name: 'Lin', aliases: ['小林'], description: 'raincoat',
        imageNodes: ['n1'], voice: { model: 'indextts', voice: 'v1', sampleNode: 'n2' },
      }],
      remove: [],
      baseRevision: 1,
    })
    expect(full.text).toContain('c1 Lin')
    const bare = await call('studio_bible_update', {
      upsert: [{ id: 'p1', kind: 'prop', name: 'Cup', description: 'a cup', voice: {} }],
    })
    expect(bare.text).toContain('p1 Cup')
    const partial = await call('studio_bible_update', {
      upsert: [{ id: 'p2', kind: 'prop', name: 'Mug', description: 'a mug', voice: { voice: 'v9' } }],
    })
    expect(partial.text).toContain('p2 Mug')
    const removed = await call('studio_bible_update', { remove: ['p1'] })
    expect(removed.text).toContain('Bible saved')
    const stale = await call('studio_bible_update', { logline: 'x', baseRevision: 1 })
    expect(stale.isError).toBe(true)
    expect(stale.text).toContain('canvas revision is')
  })

  it('expands a script, skipping scenes already laid out', async () => {
    await edit([{ op: 'add', type: 'script', text: '【场1】雨\n正文\n【场2】店\n正文' }])
    const first = await call('studio_expand_script', { script: 'n1', baseRevision: await revision() })
    expect(first.text).toContain('Created')
    const second = await call('studio_expand_script', { script: 'n1', baseRevision: await revision() })
    expect(second.text).toBe(`Revision ${String(await revision())}.`)
    const missing = await call('studio_expand_script', { script: 'n9', baseRevision: await revision() })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('does not exist')
  })
})

describe('renderer and mapper branches', () => {
  it('renders a document holding a versionless storyboard and a derivation edge', async () => {
    await ctx.canvas.edit(session, [{ op: 'add', type: 'text', text: 'a' }, { op: 'add', type: 'text', text: 'b' }], { baseRevision: 0 })
    const document = await ctx.canvas.read(session)
    const crafted = {
      ...document,
      nextId: 4,
      nodes: [
        ...document.nodes,
        { id: 'n3', type: 'storyboard', title: 'board', x: 0, y: 400, width: 10, height: 10 },
      ],
      edges: [{ id: 'n1->n2', source: 'n1', target: 'n2', kind: 'derivation' }],
    }
    await writeFile(join(directory, '.canvas', 'canvas.json'), JSON.stringify(crafted))
    const summary = await call('canvas_get', {})
    expect(summary.text).toContain('n1->n2')
    const full = await call('canvas_get', { detail: 'full' })
    expect(full.text).toContain('Shots of n3: ')
  })

  it('fills every default of a shot the caller leaves empty', async () => {
    expect(await edit([{ op: 'add', type: 'storyboard' }])).toContain('Created n1')
    expect(await edit([{ op: 'insert_shot', node: 'n1', shots: [{}] }])).toContain('Revision')
    expect(await edit([{ op: 'insert_shot', node: 'n1', shots: [] }])).toContain('Revision')
    const shots = (await ctx.canvas.read(session)).nodes[0]?.versions?.at(-1)?.shots
    expect(shots?.[0]).toMatchObject({ id: 's1', title: '', shotSize: 'medium', durationSec: 3, characters: [], props: [], dialogue: [] })
  })

  it('groups with and without a title', async () => {
    await edit([{ op: 'add', type: 'text', text: 'a' }, { op: 'add', type: 'text', text: 'b' }])
    expect(await edit([{ op: 'group', nodes: ['n1'] }])).toContain('Created g3')
    expect(await edit([{ op: 'group', title: 'Named', nodes: ['n2'] }])).toContain('Created g4')
  })

  it('writes a bible entry that carries no voice and one that carries only a sample', async () => {
    const noVoice = await call('studio_bible_update', {
      upsert: [{ id: 'p1', kind: 'prop', name: 'Cup', description: 'a cup' }],
    })
    expect(noVoice.text).toContain('p1 Cup')
    const sampleOnly = await call('studio_bible_update', {
      upsert: [{ id: 'p2', kind: 'prop', name: 'Mug', description: 'a mug', voice: { sampleNode: 'n1' } }],
    })
    expect(sampleOnly.text).toContain('p2 Mug')
  })

  it('expands a script node without a version and untitled scenes', async () => {
    await ctx.canvas.edit(session, [{ op: 'add', type: 'script', title: '剧本', text: '【场1】' }], { baseRevision: 0 })
    const document = await ctx.canvas.read(session)
    const crafted = { ...document, nodes: document.nodes.map(node => ({ ...node, versions: [], activeVersion: undefined })) }
    await mkdir(join(directory, '.canvas'), { recursive: true })
    await writeFile(join(directory, '.canvas', 'canvas.json'), JSON.stringify(crafted))
    const expanded = await call('studio_expand_script', { script: 'n1', baseRevision: document.revision })
    // A script whose active version is gone holds no scene to lay out.
    expect(expanded.text).toBe(`Revision ${String(document.revision)}.`)
    const groups = (await ctx.canvas.read(session)).nodes.filter(node => node.type === 'group')
    expect(groups).toEqual([])
  })
})

describe('last tool branches', () => {
  it('adds a generated node without naming a model', async () => {
    expect(await edit([{ op: 'add', type: 'image', path: 'a.png', prompt: 'a cat', genKind: 'image' }])).toContain('Created n1')
    expect((await ctx.canvas.read(session)).nodes[0]?.gen).toMatchObject({ prompt: 'a cat' })
  })

  it('expands a scene that has a body but no title', async () => {
    expect(await edit([{ op: 'add', type: 'script', text: '第2场\n正文' }])).toContain('Created n1')
    expect(await call('studio_expand_script', { script: 'n1', baseRevision: await revision() })).toMatchObject({ isError: false })
    const groups = (await ctx.canvas.read(session)).nodes.filter(node => node.type === 'group')
    expect(groups.map(group => group.title)).toEqual(['场2'])
  })

  it('refuses canvas tools outside a Session', async () => {
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('call-no-agent'),
      name: 'canvas_get',
      arguments: {},
    } as never)
    expect(JSON.stringify(result)).toContain('runs only inside a Session')
  })
})

describe('schema guards', () => {
  it('rejects canvas_edit without baseRevision', async () => {
    const result = await call('canvas_edit', { operations: [{ op: 'add', type: 'text', text: 'x' }] })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/baseRevision/)
  })
})
