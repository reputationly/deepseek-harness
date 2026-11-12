import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import CanvasService from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import { parseBible } from '../src/bible.ts'
import { bibleEntriesOf, parseScenes, validateShots } from '../src/storyboard.ts'
import { inferRole } from '../src/roles.ts'
import { parseProject, FREE_PROJECT } from '../src/project.ts'
import { CanvasStore } from '../src/store.ts'
import type { Shot } from '../src/types.ts'

let directory: string
let ctx: Context
let session: Session

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-guards-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService)
  session = Session.create(SessionId('canvas-guards-session'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('store', () => {
  it('returns undefined for a missing document and rethrows other read failures', async () => {
    const store = new CanvasStore(resolveConfig({}))
    expect(await store.readDocument(directory, 'project.json', () => { throw new Error('unused') })).toBeUndefined()
    await mkdir(join(directory, '.canvas'), { recursive: true })
    await writeFile(join(directory, '.canvas', 'bible.json'), 'not json')
    await expect(store.readDocument(directory, 'bible.json', parseBible)).rejects.toThrow('bible.json')
    // A path below a regular file fails with ENOTDIR, which is not a missing file.
    await writeFile(join(directory, 'not-a-directory'), 'x')
    await expect(new CanvasStore().readDocument(join(directory, 'not-a-directory'), 'x.json', parseBible))
      .rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})

describe('service guards', () => {
  it('resolves an absolute media path and passes an explicit episode through apply', async () => {
    await ctx.canvas.createProject(session, {
      format: 'drama', title: 'Rain', spec: { aspect: '9:16', resolution: '1080p', fps: 30 },
    })
    const added = await ctx.canvas.createEpisode(session, '第二集')
    const absolute = join(directory, 'clip.mp4')
    await writeFile(absolute, 'x')
    const result = await ctx.canvas.edit(session, [{ op: 'add', type: 'video', path: absolute }], {
      baseRevision: 0, episode: added.episode.id,
    })
    expect(result.created).toEqual(['n1'])
    const applied = await ctx.canvas.apply(session, [{ op: 'add', type: 'text', text: 'x' }], 1, added.episode.id)
    expect(applied.revision).toBe(2)
  })

  it('walks only storyboards and character lines when collecting bible references', async () => {
    await ctx.canvas.edit(session, [
      { op: 'add', type: 'text', text: 'not a storyboard' },
      {
        op: 'add',
        type: 'storyboard',
        shots: [{
          id: 's1' as never, title: 'shot', shotSize: 'medium', visual: '', motion: '', camera: '', durationSec: 3,
          characters: [], props: [], dialogue: [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: 'voice over' }],
          sfx: '', negative: '',
        }],
      },
    ], { baseRevision: 0 })
    const references = await ctx.canvas.bibleReferences(session)
    expect([...references.keys()]).toEqual([])
  })
})

describe('bible and storyboard branches', () => {
  it('keeps a partial voice record', () => {
    const parsed = parseBible(JSON.stringify({
      version: 1, revision: 0, logline: '', style: { visual: '', aspect: '16:9' },
      entries: [{ id: 'c1', kind: 'character', name: 'Lin', description: 'x', voice: { model: 'm' } }],
    }))
    expect(parsed.entries[0]?.voice).toEqual({ model: 'm' })
  })

  it('reports invalid JSON with the parser message', () => {
    expect(() => parseBible('{')).toThrow('bible.json: ')
  })

  it('counts scenes written with a bracketed number and no title', () => {
    expect(parseScenes('【场3】\nbody')).toEqual([{ number: 3, title: '', body: 'body' }])
    expect(parseScenes('## 第4场 标题\nbody')).toEqual([{ number: 4, title: '标题', body: 'body' }])
    expect(parseScenes('场5 body text')).toEqual([{ number: 5, title: 'body text', body: '' }])
  })

  it('flags a shot without a shot size and a narrator line', () => {
    const shot = {
      id: 's1' as Shot['id'], title: 't', shotSize: undefined, visual: '', motion: '', camera: '', durationSec: 1,
      characters: [], props: [], dialogue: [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: 'x' }], sfx: '', negative: '',
    } as unknown as Shot
    expect(validateShots([shot], { version: 1, revision: 0, logline: '', style: { visual: '', aspect: '16:9' }, entries: [] }))
      .toEqual(['shot s1 has no shot size'])
    expect(bibleEntriesOf([shot])).toEqual([])
  })

  it('infers no role from a group or from a prompt source into text', () => {
    expect(inferRole('group', 'image')).toBeUndefined()
    expect(inferRole('image', 'text')).toBeUndefined()
    expect(inferRole('audio', 'image')).toBeUndefined()
    expect(inferRole('video', 'video')).toBeUndefined()
    expect(inferRole('text', 'storyboard')).toBe('prompt')
    expect(inferRole('storyboard', 'script')).toBe('prompt')
  })
})

describe('canvas files', () => {
  it('leaves a corrupt project file untouched', async () => {
    await mkdir(join(directory, '.canvas'), { recursive: true })
    await writeFile(join(directory, '.canvas', 'project.json'), '{"version":9}')
    await expect(ctx.canvas.read(session)).rejects.toThrow('unsupported version')
    expect(await readFile(join(directory, '.canvas', 'project.json'), 'utf8')).toBe('{"version":9}')
  })
})

describe('last branches', () => {
  it('counts a storyboard with no version as referencing nothing', async () => {
    await mkdir(join(directory, '.canvas'), { recursive: true })
    await writeFile(join(directory, '.canvas', 'canvas.json'), JSON.stringify({
      version: 2, revision: 0, nextId: 2,
      nodes: [{ id: 'n1', type: 'storyboard', title: 'board', x: 0, y: 0, width: 1, height: 1 }],
      edges: [],
    }))
    expect([...(await ctx.canvas.bibleReferences(session)).keys()]).toEqual([])
  })

  it('keeps the canvas file when a write cannot replace it', async () => {
    await ctx.canvas.edit(session, [{ op: 'add', type: 'text', text: 'a' }], { baseRevision: 0 })
    const root = join(directory, '.canvas')
    await chmod(root, 0o500)
    try {
      await expect(ctx.canvas.edit(session, [{ op: 'add', type: 'text', text: 'b' }], { baseRevision: 1 }))
        .rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(root, 0o700)
    }
  })
})

describe('storyboard duplicates', () => {
  it('lists each entry once when a shot repeats it', async () => {
    const { bibleEntriesOf } = await import('../src/storyboard.ts')
    const shot: Shot = {
      id: 's1' as never, title: 't', shotSize: 'medium', visual: '', motion: '', camera: '', durationSec: 2,
      characters: ['c1' as never, 'c1' as never], props: [], scene: 'c1' as never,
      dialogue: [
        { id: 'd1' as never, speaker: { kind: 'character' as const, entry: 'c1' as never }, line: 'x' },
        { id: 'd2' as never, speaker: { kind: 'character' as const, entry: 'c1' as never }, line: 'y' },
        { id: 'd3' as never, speaker: { kind: 'character' as const, entry: 'c2' as never }, line: 'z' },
      ],
      sfx: '', negative: '',
    }
    expect(bibleEntriesOf([shot])).toEqual(['c1', 'c2'])
  })
})

describe('document writes', () => {
  it('leaves the file untouched when the change returns no document', async () => {
    const store = new CanvasStore(resolveConfig({}))
    const result = await store.updateDocument(directory, 'project.json', parseProject, () => FREE_PROJECT, current => ({
      value: current.revision,
    }))
    expect(result).toEqual({ value: 0, revision: 0 })
  })
})
