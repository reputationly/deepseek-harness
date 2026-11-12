import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import CanvasService, { CanvasConflictError } from '../src/index.ts'
import {
  advanceStage, EMPTY_PRODUCTION, gateBibleFirst, gateStoryboardQuality, parseProduction, parseProductionFile,
  serializeProduction, stageOf, videoNodesByShots,
} from '../src/production.ts'
import type { Bible } from '../src/bible.ts'
import type { CanvasDocument, Shot } from '../src/types.ts'

const bible: Bible = {
  version: 1,
  revision: 0,
  logline: '',
  style: { visual: '', aspect: '16:9' },
  entries: [
    { id: 'c1' as never, kind: 'character', name: 'Lin', aliases: [], description: 'raincoat', imageNodes: [] },
    { id: 'l1' as never, kind: 'location', name: 'Shop', aliases: [], description: 'store', imageNodes: [] },
  ],
}

const shot = (id: string, overrides: Partial<Shot> = {}): Shot => ({
  id: id as Shot['id'],
  title: id,
  shotSize: 'medium',
  visual: '',
  motion: '',
  camera: '',
  durationSec: 3,
  characters: [],
  props: [],
  dialogue: [],
  sfx: '',
  negative: '',
  ...overrides,
})

const document = (nodes: CanvasDocument['nodes']): CanvasDocument => ({ version: 2, revision: 0, nextId: 2, nodes, edges: [] })

describe('production record', () => {
  it('round-trips and defaults to the brief stage', () => {
    const production = advanceStage(EMPTY_PRODUCTION, 'e1', 'bible', undefined, 'now')
    expect(parseProduction(serializeProduction(production))).toEqual(production)
    expect(stageOf(production, 'e1')).toBe('bible')
    expect(stageOf(production, 'e2')).toBe('brief')
  })

  it('moves one stage forward without an override', () => {
    const production = advanceStage(EMPTY_PRODUCTION, 'e1', 'bible', undefined, 'now')
    expect(production.episodes.e1).toEqual({ stage: 'bible', overrides: [] })
  })

  it('refuses to skip or move back without an override, and records one that is given', () => {
    const bibleStage = advanceStage(EMPTY_PRODUCTION, 'e1', 'bible', undefined, 'now')
    expect(() => advanceStage(bibleStage, 'e1', 'script', undefined, 'now')).toThrow('cannot skip')
    expect(() => advanceStage(bibleStage, 'e1', 'brief', undefined, 'now')).toThrow('cannot move back')
    const skipped = advanceStage(bibleStage, 'e1', 'script', { gate: 'G4_stage_order', reason: 'user asked' }, 'now')
    expect(skipped.episodes.e1?.overrides).toEqual([{ gate: 'G4_stage_order', at: 'now', reason: 'user asked' }])
  })

  it('rejects malformed files', () => {
    const bad = [
      'not json',
      '[]',
      '{"version":2}',
      '{"version":1,"revision":-1,"episodes":{}}',
      '{"version":1,"revision":0,"episodes":[]}',
      '{"version":1,"revision":0,"episodes":{"e1":{"stage":"nope"}}}',
      '{"version":1,"revision":0,"episodes":{"e1":{"stage":"bible","overrides":[{"gate":"G1_bible_first"}]}}}',
      '{"version":1,"revision":0,"episodes":{"e1":3}}',
      '{"version":1,"revision":0,"episodes":{"e1":{"stage":"bible","overrides":[3]}}}',
    ]
    for (const source of bad) expect(() => parseProduction(source)).toThrow()
    expect(() => parseProductionFile('nope')).toThrow()
  })
})

describe('gates', () => {
  it('requires bible entries before reference images', () => {
    expect(gateBibleFirst(undefined)).toEqual({ gate: 'G1_bible_first', missing: ['bible.json has no entries'] })
    expect(gateBibleFirst(bible)).toBeUndefined()
  })

  it('accepts an episode without overrides and ignores non-storyboard nodes', () => {
    expect(parseProduction('{"version":1,"revision":0,"episodes":{"e1":{"stage":"assets"}}}').episodes.e1).toEqual({ stage: 'assets', overrides: [] })
    const mixed = document([
      { id: 'n1' as never, type: 'text', title: 'notes', x: 0, y: 0, width: 1, height: 1, versions: [{ id: 'v1' as never, text: 'x', createdAt: 'now', origin: 'user' }], activeVersion: 'v1' as never },
      { id: 'n2' as never, type: 'storyboard', title: 'board', x: 0, y: 0, width: 1, height: 1 },
      { id: 'n3' as never, type: 'storyboard', title: 'board', x: 0, y: 0, width: 1, height: 1, versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1', { characters: ['c1' as never], dialogue: [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: 'x' }] })] }], activeVersion: 'v1' as never },
    ])
    expect(gateStoryboardQuality(mixed, bible)).toBeUndefined()
    // Without a bible no entry can satisfy the gate, so a cited entry is missing.
    expect(gateStoryboardQuality(mixed, undefined)).toEqual({
      gate: 'G2_storyboard_quality',
      missing: ['n3 shot s1: bible entry c1'],
    })
  })

  it('lists what a storyboard still misses', () => {
    const board = document([{
      id: 'n1' as never, type: 'storyboard', title: 'board', x: 0, y: 0, width: 1, height: 1,
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [
        shot('s1', { shotSize: undefined as never, durationSec: 0, characters: ['c9' as never] }),
        shot('s2', { scene: 'l1' as never, dialogue: [{ id: 'd1' as never, speaker: { kind: 'character', entry: 'c8' as never }, line: 'x' }] }),
      ] }],
      activeVersion: 'v1' as never,
    }])
    const refusal = gateStoryboardQuality(board, bible)
    expect(refusal?.gate).toBe('G2_storyboard_quality')
    expect(refusal?.missing).toEqual([
      'n1 shot s1: shotSize',
      'n1 shot s1: durationSec',
      'n1 shot s1: bible entry c9',
      'n1 shot s2: bible entry c8',
    ])
    expect(gateStoryboardQuality(document([]), bible)).toBeUndefined()
  })

  it('groups video nodes by the shots they stand for', () => {
    const board = document([
      { id: 'v1' as never, type: 'video', title: 'a', x: 0, y: 0, width: 1, height: 1, activeVersion: 'v1' as never, versions: [{ id: 'v1' as never, path: '/a.mp4', createdAt: 'now', origin: 'user' }], gen: { kind: 'video', prompt: 'p', params: {}, shot: { storyboard: 'n1' as never, shots: ['s1' as never] } } },
      { id: 'v2' as never, type: 'video', title: 'b', x: 0, y: 0, width: 1, height: 1, activeVersion: 'v1' as never, versions: [{ id: 'v1' as never, path: '/b.mp4', createdAt: 'now', origin: 'user' }], gen: { kind: 'video', prompt: 'p', params: {}, shot: { storyboard: 'n1' as never, shots: ['s1' as never] } } },
      { id: 'v3' as never, type: 'video', title: 'c', x: 0, y: 0, width: 1, height: 1, activeVersion: 'v1' as never, versions: [{ id: 'v1' as never, path: '/c.mp4', createdAt: 'now', origin: 'user' }], gen: { kind: 'video', prompt: 'p', params: {}, shot: { storyboard: 'n2' as never, shots: ['s1' as never] } } },
    ])
    expect(videoNodesByShots(board, 'n1').map(group => [group.shots, group.nodes.map(node => node.id)])).toEqual([
      [['s1'], ['v1', 'v2']],
    ])
    const loose = document([{
      id: 'v1' as never, type: 'video', title: 'a', x: 0, y: 0, width: 1, height: 1,
      activeVersion: 'v1' as never,
      versions: [{ id: 'v1' as never, path: '/a.mp4', createdAt: 'now', origin: 'user' }],
      gen: { kind: 'video', prompt: 'p', params: {}, shot: { storyboard: 'n1' as never, shots: [] } },
    }])
    expect(videoNodesByShots(loose, 'n1')[0]?.shots).toEqual([])
  })
})

describe('service stage writes', () => {
  let directory: string
  let ctx: Context
  let session: Session

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-canvas-production-'))
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    provideWorkingDirectoryFixture(ctx, directory)
    await ctx.plugin(CanvasService)
    session = Session.create(SessionId('canvas-production-session'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function call(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId(`call-${name}`),
      name,
      arguments: args,
      agent: { id: session.id, session } as never,
    })
    return { text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''), isError: result.isError }
  }

  it('writes the stage and refuses a stale revision', async () => {
    const first = await ctx.canvas.setStage(session, 'bible')
    expect(first.revision).toBe(1)
    expect(first.previous).toBe('brief')
    await expect(ctx.canvas.setStage(session, 'script', undefined, 9)).rejects.toBeInstanceOf(CanvasConflictError)
    const skipped = await ctx.canvas.setStage(session, 'script', { gate: 'G4_stage_order', reason: 'ok' })
    expect(skipped.production.episodes.e1?.overrides).toHaveLength(1)
    await writeFile(join(directory, '.canvas', 'production.json'), '{bad')
    const status = await call('studio_stage', { action: 'status' })
    expect(status.isError).toBe(true)
  })

  it('reports and advances the stage through the tool', async () => {
    expect((await call('studio_stage', { action: 'status' })).text).toContain('Production stage is brief')
    expect((await call('studio_stage', { action: 'advance', to: 'bible' })).text).toContain('Production stage is bible')
    const skipping = await call('studio_stage', { action: 'advance', to: 'generating' })
    expect(skipping.isError).toBe(true)
    const overridden = await call('studio_stage', { action: 'advance', to: 'generating', gate: 'G4_stage_order', reason: 'user asked' })
    expect(overridden.isError).toBe(false)
    const advanceWithoutStage = await call('studio_stage', { action: 'advance' })
    expect(advanceWithoutStage.isError).toBe(true)
  })
})
