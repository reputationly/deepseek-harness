import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
import CanvasService, { CanvasConflictError } from '../src/index.ts'
import { canvasFile } from '../src/store.ts'
import type { CanvasChange } from '../src/types.ts'

let directory: string
let ctx: Context
let session: Session
let changes: CanvasChange[]
let calls = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-studio-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService)
  session = Session.create(SessionId('canvas-studio-session'))
  changes = []
  ctx.on('canvas/change', (change) => { changes.push(change) })
})

afterEach(() => {
  // The fixture cleans the Harness home; the project directory is a plain temp directory.
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

describe('studio project and episodes', () => {
  it('creates a project whose first episode reuses the single canvas', async () => {
    await ctx.canvas.edit(session, [{ op: 'add', type: 'text', text: 'existing' }], { baseRevision: 0 })
    const created = await ctx.canvas.createProject(session, {
      format: 'drama', title: 'Rain', spec: { aspect: '9:16', resolution: '1080p', fps: 30 },
    })
    expect(created.revision).toBe(1)
    expect(created.project).toMatchObject({ format: 'drama', title: 'Rain', spec: { aspect: '9:16' } })
    expect(created.project.episodes).toEqual([{ id: 'e1', title: '第 1 集', file: 'canvas.json' }])
    expect((await ctx.canvas.read(session)).nodes.map(node => node.id)).toEqual(['n1'])
    expect(changes.at(-1)).toMatchObject({ directory, revisions: { project: 1 } })
    await expect(ctx.canvas.createProject(session, {
      format: 'drama', title: 'Again', spec: { aspect: '9:16', resolution: '1080p', fps: 30 },
    })).rejects.toThrow('already has project.json')
  })

  it('adds an episode with its own canvas file and switches the session to it', async () => {
    await ctx.canvas.createProject(session, {
      format: 'drama', title: 'Rain', spec: { aspect: '9:16', resolution: '1080p', fps: 30 },
    })
    const added = await ctx.canvas.createEpisode(session, '第二集')
    expect(added.episode).toEqual({ id: 'e2', title: '第二集' })
    expect(added.revision).toBe(2)
    await ctx.canvas.useEpisode(session, added.episode.id)
    expect((await ctx.canvas.read(session)).revision).toBe(0)
    await ctx.canvas.edit(session, [{ op: 'add', type: 'text', text: 'scene' }], { baseRevision: 0 })
    expect((await ctx.canvas.read(session)).nodes).toHaveLength(1)
    // Episode 1 stays untouched.
    expect((await ctx.canvas.read(session, 'e1' as never)).nodes).toEqual([])
    expect(changes.at(-1)).toMatchObject({ directory, episode: 'e2', revisions: { canvas: 1 } })
    await expect(ctx.canvas.useEpisode(session, 'e9' as never)).rejects.toThrow('does not exist')
    await expect(ctx.canvas.read(session, 'e9' as never)).rejects.toThrow('does not exist')
  })

  it('refuses episode writes before the project exists', async () => {
    await expect(ctx.canvas.createEpisode(session, '第一集')).rejects.toThrow('no project.json')
    await expect(ctx.canvas.useEpisode(session, 'e1' as never)).rejects.toThrow('no project.json')
  })

  it('reports the project, its episodes, and the current episode', async () => {
    const empty = await ctx.canvas.projectOf(session)
    expect(empty).toMatchObject({ project: undefined, revision: 0, current: { id: 'e1' } })
    await ctx.canvas.createProject(session, {
      format: 'mv', title: 'Song', spec: { aspect: '16:9', resolution: '1080p', fps: 24 },
    })
    const created = await ctx.canvas.projectOf(session)
    expect(created.project?.format).toBe('mv')
    expect(created.episodes.map(episode => episode.id)).toEqual(['e1'])
    expect(created.current.title).toBe('第 1 集')
  })
})

describe('studio bible', () => {
  it('starts empty and records the entries a caller writes', async () => {
    const before = await ctx.canvas.bibleOf(session)
    expect(before).toMatchObject({ revision: 0, bible: { entries: [] } })
    const updated = await ctx.canvas.updateBible(session, {
      logline: 'a rainy night',
      style: { visual: 'cinematic', aspect: '9:16' },
      upsert: [{
        id: 'c1' as never, kind: 'character', name: 'Lin', aliases: [], description: 'raincoat', imageNodes: ['n1' as never],
      }],
    })
    expect(updated.revision).toBe(1)
    expect(updated.bible.entries).toHaveLength(1)
    expect(updated.bible.style).toMatchObject({ visual: 'cinematic', aspect: '9:16' })
    expect(changes.at(-1)).toMatchObject({ directory, revisions: { bible: 1 } })
  })

  it('rejects a stale base revision and a removal a storyboard still references', async () => {
    await ctx.canvas.updateBible(session, {
      upsert: [{ id: 'c1' as never, kind: 'character', name: 'Lin', aliases: [], description: 'raincoat', imageNodes: [] }],
    })
    await expect(ctx.canvas.updateBible(session, { logline: 'stale' }, 5)).rejects.toBeInstanceOf(CanvasConflictError)
    await ctx.canvas.edit(session, [{
      op: 'add',
      type: 'storyboard',
      shots: [{
        id: 's1' as never, title: 'shot', shotSize: 'medium', visual: '', motion: '', camera: '', durationSec: 3,
        characters: ['c1' as never], props: [], dialogue: [{ id: 'd1' as never, speaker: { kind: 'character', entry: 'c1' as never }, line: 'hi' }],
        sfx: '', negative: '',
      }],
    }, {
      op: 'add',
      type: 'storyboard',
      shots: [{
        id: 's1' as never, title: 'shot', shotSize: 'medium', visual: '', motion: '', camera: '', durationSec: 3,
        characters: [], props: [], scene: 'c1' as never, dialogue: [], sfx: '', negative: '',
      }],
    }], { baseRevision: 0 })
    await expect(ctx.canvas.updateBible(session, { remove: ['c1' as never] }))
      .rejects.toThrow('still referenced by a storyboard')
    const references = await ctx.canvas.bibleReferences(session)
    expect(references.get('c1' as never)).toEqual(['n1', 'n2'])
  })

  it('removes an entry no storyboard uses', async () => {
    await ctx.canvas.updateBible(session, {
      upsert: [{ id: 'p1' as never, kind: 'prop', name: 'Cup', aliases: [], description: 'a paper cup', imageNodes: [] }],
    })
    const removed = await ctx.canvas.updateBible(session, { remove: ['p1' as never] })
    expect(removed.bible.entries).toEqual([])
    expect(removed.revision).toBe(2)
  })
})

describe('canvas read details', () => {
  it('reports the project and bible when asked for them', async () => {
    await ctx.canvas.createProject(session, {
      format: 'drama', title: 'Rain', spec: { aspect: '9:16', resolution: '1080p', fps: 30 },
    })
    await ctx.canvas.updateBible(session, { logline: 'rain', style: { visual: 'noir' } })
    const plain = await call('canvas_get', {})
    expect(plain.text).toContain('episode e1')
    expect(plain.text).not.toContain('Project:')
    const included = await call('canvas_get', { include: ['project', 'bible'], detail: 'full' })
    expect(included.text).toContain('Project: ')
    expect(included.text).toContain('Bible: ')
    expect(included.text).toContain('noir')
  })

  it('returns the shots of a storyboard in full detail and shortens text in summary', async () => {
    await ctx.canvas.edit(session, [
      { op: 'add', type: 'text', text: 'x'.repeat(300) },
      {
        op: 'add',
        type: 'storyboard',
        shots: [{
          id: 's1' as never, title: 'shot', shotSize: 'close', visual: 'a street', motion: '', camera: '', durationSec: 3,
          characters: [], props: [], dialogue: [], sfx: '', negative: '',
        }],
      },
    ], { baseRevision: 0 })
    const summary = await call('canvas_get', {})
    expect(summary.text).toContain('…')
    const full = await call('canvas_get', { detail: 'full' })
    expect(full.text).toContain('Shots of n2: s1 close 3s')
    expect(full.text).toContain('x'.repeat(300))
  })
})

describe('studio script expansion', () => {
  const script = '【场1】雨夜\n第一场\n\n【场2】便利店\n第二场\n\n【场3】天台\n第三场'

  it('lays one group per scene with a text node and a storyboard that reads it', async () => {
    await ctx.canvas.edit(session, [{ op: 'add', type: 'script', title: '剧本', text: script }], { baseRevision: 0 })
    const expanded = await call('studio_expand_script', { script: 'n1', baseRevision: 1 })
    expect(expanded.isError).toBe(false)
    const document = await ctx.canvas.read(session)
    expect(document.nodes.filter(node => node.type === 'group')).toHaveLength(3)
    expect(document.nodes.filter(node => node.type === 'text')).toHaveLength(3)
    expect(document.nodes.filter(node => node.type === 'storyboard')).toHaveLength(3)
    expect(document.edges.filter(edge => edge.role === 'prompt')).toHaveLength(3)
    const again = await call('studio_expand_script', { script: 'n1', baseRevision: document.revision })
    expect(again.text).toBe(`Revision ${String(document.revision)}.`)
    expect((await ctx.canvas.read(session)).nodes).toHaveLength(document.nodes.length)
  })

  it('expands only the scenes the caller names', async () => {
    await ctx.canvas.edit(session, [{ op: 'add', type: 'text', title: '剧本', text: script }], { baseRevision: 0 })
    await call('studio_expand_script', { script: 'n1', scenes: [2], baseRevision: 1 })
    const groups = (await ctx.canvas.read(session)).nodes.filter(node => node.type === 'group')
    expect(groups.map(group => group.title)).toEqual(['场2 便利店'])
  })

  it('rejects a script node that is missing or holds no script', async () => {
    await writeFile(join(directory, 'a.png'), 'x')
    await ctx.canvas.edit(session, [{ op: 'add', type: 'image', path: 'a.png' }], { baseRevision: 0 })
    expect((await call('studio_expand_script', { script: 'n9', baseRevision: 1 })).text).toContain('n9 does not exist')
    expect((await call('studio_expand_script', { script: 'n1', baseRevision: 1 })).text).toContain('holds no script text')
  })
})

describe('studio tools', () => {
  it('creates a project, an episode, and switches to it through the tools', async () => {
    const project = await call('studio_project_create', {
      format: 'comic', title: 'Comic', aspect: '9:16', resolution: '1080p', fps: 30,
    })
    expect(project.text).toContain('Project "Comic" (comic) created with 1 episode(s)')
    const episode = await call('studio_episode_create', { title: '第二集' })
    expect(episode.text).toContain('Episode e2 "第二集" created')
    const used = await call('studio_episode_use', { episode: 'e2' })
    expect(used.text).toContain('now edits that episode')
  })

  it('writes bible entries and reports them', async () => {
    const updated = await call('studio_bible_update', {
      logline: 'rain',
      style: { visual: 'noir', aspect: '9:16' },
      upsert: [{
        id: 'c1', kind: 'character', name: 'Lin', aliases: ['小林'], description: 'raincoat',
        imageNodes: ['n1'], voice: { model: 'indextts', voice: 'v1', sampleNode: 'n2' },
      }],
      remove: [],
    })
    expect(updated.text).toContain('Bible saved at revision 1 with 1 entries: c1 Lin')
    const bible = await ctx.canvas.bibleOf(session)
    expect(bible.bible.entries[0]?.voice).toEqual({ model: 'indextts', voice: 'v1', sampleNode: 'n2' })
  })

  it('answers a stale base revision and an unsupported canvas version as Remote errors', async () => {
    const conflict = await ctx.canvas.apply(session, [{ op: 'add', type: 'text', text: 'x' }], 9).catch((error: unknown) => error)
    expect(conflict).toBeInstanceOf(RemoteError)
    expect(conflict).toMatchObject({ code: 'canvas/conflict', details: { expected: 9, actual: 0 } })
    await mkdir(join(directory, '.canvas'), { recursive: true })
    await writeFile(canvasFile(directory), '{"version":3,"revision":0,"nextId":1,"nodes":[],"edges":[]}')
    const failure = await ctx.canvas.get(session).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect(failure).toMatchObject({ code: 'canvas/unsupported-version', details: { version: 3 } })
  })

  it('refuses more operations than the deployment accepts', async () => {
    const many = Array.from({ length: 65 }, () => ({ op: 'add' as const, type: 'text' as const, text: 'x' }))
    await expect(ctx.canvas.edit(session, many)).rejects.toThrow('exceed the 64')
  })
})

describe('episode isolation', () => {
  it('keeps concurrent writes to two episodes from overwriting each other', async () => {
    await ctx.canvas.createProject(session, {
      format: 'drama', title: 'Rain', spec: { aspect: '9:16', resolution: '1080p', fps: 30 },
    })
    const second = await ctx.canvas.createEpisode(session, '第二集')
    const first = 'e1' as never
    await Promise.all([
      ctx.canvas.edit(session, [{ op: 'add', type: 'text', text: '第一集' }], { baseRevision: 0, episode: first }),
      ctx.canvas.edit(session, [{ op: 'add', type: 'text', text: '第二集' }], { baseRevision: 0, episode: second.episode.id }),
    ])
    const firstNodes = (await ctx.canvas.read(session, first)).nodes
    const secondNodes = (await ctx.canvas.read(session, second.episode.id)).nodes
    expect(firstNodes).toHaveLength(1)
    expect(secondNodes).toHaveLength(1)
    expect(firstNodes[0]?.versions?.[0]?.text).toBe('第一集')
    expect(secondNodes[0]?.versions?.[0]?.text).toBe('第二集')
  })
})

describe('script expansion idempotency', () => {
  it('reuses the group that records the same script and scene, whatever its title says now', async () => {
    await ctx.canvas.edit(session, [
      { op: 'add', type: 'script', text: '【场1】雨夜\nbody one\n【场2】便利店\nbody two' },
      { op: 'add', type: 'text', title: '场1 旧标题', text: 'body one' },
      { op: 'add', type: 'text', title: '场2 便利店 收银台', text: 'body two' },
      { op: 'group', title: '场1 旧标题', nodes: ['n2'], sceneOrigin: { script: 'n1' as never, scene: 1 } },
      { op: 'group', title: '场2 便利店 收银台', nodes: ['n3'], sceneOrigin: { script: 'n1' as never, scene: 2 } },
    ], { baseRevision: 0 })
    const before = (await ctx.canvas.read(session)).nodes.length
    const expanded = await call('studio_expand_script', { script: 'n1', baseRevision: (await ctx.canvas.read(session)).revision })
    expect(expanded.isError).toBe(false)
    expect((await ctx.canvas.read(session)).nodes).toHaveLength(before)
  })

  it('does not treat an unrelated group that happens to be titled 场1 as an expanded scene', async () => {
    await ctx.canvas.edit(session, [
      { op: 'add', type: 'script', text: '【场1】雨夜\nbody one' },
      { op: 'add', type: 'text', title: 'notes', text: 'my notes' },
      { op: 'group', title: '场1 我的分组', nodes: ['n2'] },
    ], { baseRevision: 0 })
    const expanded = await call('studio_expand_script', { script: 'n1', baseRevision: (await ctx.canvas.read(session)).revision })
    expect(expanded.isError).toBe(false)
    expect(expanded.text).toContain('Created')
    const groups = (await ctx.canvas.read(session)).nodes.filter(node => node.type === 'group')
    expect(groups.map(group => group.sceneOrigin?.scene)).toEqual([undefined, 1])
  })
})
