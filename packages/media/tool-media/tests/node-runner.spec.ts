import { describe, expect, it } from 'vitest'
import type { Bible, CanvasDocument, CanvasNode, Shot } from '@deepseek-ai/dsh-canvas'
import { collectInputs, planNodes, segmentPrompt, type PlanLimits } from '../src/node-runner.ts'

const limits: PlanLimits = {
  maxVideoSeconds: 15,
  videoDefaultDuration: 5,
  videoModel: 'video-model',
  videoRefModel: 'video-ref-model',
  imageModel: 'image-model',
  speechModel: 'speech-model',
  musicModel: 'music-model',
}

const bible: Bible = {
  version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' },
  entries: [
    { id: 'linxia' as never, kind: 'character', name: '林夏', aliases: [], description: '店员', imageNodes: ['n1' as never] },
  ],
}

const shot = (id: string, overrides: Partial<Shot> = {}): Shot => ({
  id: id as never, title: id, shotSize: 'medium', visual: `画面 ${id}`, motion: '动作', camera: '固定', durationSec: 3,
  characters: [], props: [], dialogue: [], sfx: '', negative: '水印', ...overrides,
})

const node = (id: string, type: CanvasNode['type'], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id: id as never, type, title: id, x: 0, y: 0, width: 1, height: 1, ...extra,
})

const imageNode = (id: string, path: string): CanvasNode => node(id, 'image', {
  versions: [{ id: 'v1' as never, path, createdAt: 'now', origin: 'user' }],
  activeVersion: 'v1' as never,
})

const boardNode = (id: string, shots: readonly Shot[]): CanvasNode => node(id, 'storyboard', {
  versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots }],
  activeVersion: 'v1' as never,
})

const videoNode = (id: string, storyboard: string, shotIds: readonly string[], extra: Partial<CanvasNode> = {}): CanvasNode =>
  node(id, 'video', {
    gen: {
      kind: 'video', prompt: '', params: {},
      shot: { storyboard: storyboard as never, shots: shotIds.map(shotId => shotId as never) },
    },
    ...extra,
  })

const documentOf = (nodes: readonly CanvasNode[], edges: CanvasDocument['edges'] = []): CanvasDocument => ({
  version: 2, revision: 0, nextId: nodes.length + 1, nodes, edges,
})

describe('segmentPrompt', () => {
  it('renders one timed line per shot with the speaker name', () => {
    const shots = [
      shot('s1', {
        shotSize: 'wide', durationSec: 3,
        dialogue: [{ id: 'd1' as never, speaker: { kind: 'character', entry: 'linxia' as never }, line: '你好' }],
      }),
      shot('s2', { durationSec: 2, dialogue: [{ id: 'd2' as never, speaker: { kind: 'narrator' }, line: '旁白' }] }),
    ]
    expect(segmentPrompt(shots, bible).split('\n')).toEqual([
      '0–3s [wide] 画面 s1。动作：动作。运镜：固定。台词（林夏：你好）。避免：水印',
      '3–5s [medium] 画面 s2。动作：动作。运镜：固定。台词（旁白：旁白）。避免：水印',
    ])
  })
})

describe('collectInputs', () => {
  it('joins text prompt edges, the covered storyboard shots, and the node prompt', () => {
    const document = documentOf([
      node('n1', 'text', {
        versions: [{ id: 'v1' as never, text: '整体风格：冷青灰', createdAt: 'now', origin: 'user' }],
        activeVersion: 'v1' as never,
      }),
      boardNode('n2', [shot('s1'), shot('s2'), shot('s3')]),
      videoNode('n3', 'n2', ['s2', 's3'], {
        gen: { kind: 'video', prompt: '镜头语言：手持', params: {}, shot: { storyboard: 'n2' as never, shots: ['s2' as never, 's3' as never] } },
      }),
    ], [
      { id: 'n1->n3:prompt', source: 'n1' as never, target: 'n3' as never, kind: 'reference', role: 'prompt' },
      { id: 'n2->n3:prompt', source: 'n2' as never, target: 'n3' as never, kind: 'reference', role: 'prompt' },
    ])
    const inputs = collectInputs(document, document.nodes[2] as CanvasNode, bible)
    expect(inputs.prompt).toContain('整体风格：冷青灰')
    expect(inputs.prompt).toContain('0–3s [medium] 画面 s2')
    expect(inputs.prompt).not.toContain('画面 s1')
    expect(inputs.prompt).toContain('镜头语言：手持')
  })

  it('orders reference images by the edge order and resolves the frame slots', () => {
    const document = documentOf([
      imageNode('n1', '/a.png'), imageNode('n2', '/b.png'), imageNode('n3', '/first.png'),
      node('n4', 'video', { gen: { kind: 'video', prompt: '', params: {} } }),
    ], [
      { id: 'n2->n4:ref', source: 'n2' as never, target: 'n4' as never, kind: 'reference', role: 'ref', order: 1 },
      { id: 'n1->n4:ref', source: 'n1' as never, target: 'n4' as never, kind: 'reference', role: 'ref', order: 0 },
      { id: 'n3->n4:first_frame', source: 'n3' as never, target: 'n4' as never, kind: 'reference', role: 'first_frame' },
    ])
    const inputs = collectInputs(document, document.nodes[3] as CanvasNode, bible)
    expect(inputs.refs.map(ref => ref.path)).toEqual(['/a.png', '/b.png'])
    expect(inputs.firstFrame?.path).toBe('/first.png')
    expect(inputs.lastFrame).toBeUndefined()
  })
})

describe('input edge edge cases', () => {
  it('falls back to the entry id when the bible cannot name a speaker, and skips dangling inputs', () => {
    const line = { id: 'd1' as never, speaker: { kind: 'character' as const, entry: 'ghost' as never }, line: 'x' }
    expect(segmentPrompt([shot('s1', { dialogue: [line] })], undefined)).toContain('台词（ghost：x）')
    const document = documentOf([
      node('n1', 'image'),
      node('n2', 'video', { gen: { kind: 'video', prompt: '', params: {} } }),
    ], [
      { id: 'n9->n2:ref', source: 'n9' as never, target: 'n2' as never, kind: 'reference', role: 'ref' },
      { id: 'n1->n2:ref', source: 'n1' as never, target: 'n2' as never, kind: 'reference', role: 'ref' },
      { id: 'n1->n2:last_frame', source: 'n1' as never, target: 'n2' as never, kind: 'reference', role: 'last_frame' },
    ])
    const inputs = collectInputs(document, document.nodes[1] as CanvasNode, bible)
    expect(inputs.refs).toEqual([])
    expect(inputs.lastFrame).toBeUndefined()
  })

  it('reads a storyboard without a version as covering no shots and keeps the whole table when the node names no shots', () => {
    const document = documentOf([
      node('n1', 'text'),
      node('n2', 'storyboard'),
      node('n3', 'video', { gen: { kind: 'video', prompt: '', params: {} } }),
    ], [
      { id: 'n1->n3:prompt', source: 'n1' as never, target: 'n3' as never, kind: 'reference', role: 'prompt' },
      { id: 'n2->n3:prompt', source: 'n2' as never, target: 'n3' as never, kind: 'reference', role: 'prompt' },
    ])
    expect(collectInputs(document, document.nodes[2] as CanvasNode, bible).prompt).toBe('')
  })

  it('resolves a derivation edge source as a plain input and keeps a last frame slot', () => {
    const document = documentOf([
      imageNode('n1', '/a.png'), imageNode('n2', '/b.png'),
      node('n3', 'video', { gen: { kind: 'video', prompt: '', params: {} } }),
      node('n4', 'text'),
    ], [
      { id: 'n1->n3', source: 'n1' as never, target: 'n3' as never, kind: 'derivation' },
      { id: 'n2->n3:last_frame', source: 'n2' as never, target: 'n3' as never, kind: 'reference', role: 'last_frame' },
      { id: 'n4->n3', source: 'n4' as never, target: 'n3' as never, kind: 'derivation' },
    ])
    const inputs = collectInputs(document, document.nodes[2] as CanvasNode, bible)
    expect(inputs.lastFrame?.path).toBe('/b.png')
    expect(inputs.prompt).toBe('')
  })

  it('keeps every shot of the storyboard when the node names none', () => {
    const document = documentOf([
      node('n2', 'storyboard', {
        versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1')] }],
        activeVersion: 'v1' as never,
      }),
      node('n3', 'video', { gen: { kind: 'video', prompt: '', params: {} } }),
    ], [{ id: 'n2->n3:prompt', source: 'n2' as never, target: 'n3' as never, kind: 'reference', role: 'prompt' }])
    expect(collectInputs(document, document.nodes[1] as CanvasNode, bible).prompt).toContain('画面 s1')
  })
})

describe('planNodes', () => {
  it('plans one video per segment and creates the missing nodes', () => {
    const board = boardNode('n2', ['s1', 's2', 's3', 's4', 's5'].map(shotId => shot(shotId)))
    const plan = planNodes(documentOf([board]), bible, ['n2'], limits)
    expect(plan.blocked).toBeUndefined()
    expect(plan.entries.map(entry => [entry.kind, entry.seconds, entry.model, entry.shots?.length])).toEqual([
      ['video', 15, 'video-ref-model', 5],
    ])
    expect(plan.create).toHaveLength(1)
    expect(plan.create[0]).toMatchObject({ op: 'add', type: 'video', title: 'n2 · 段1', gen: { kind: 'video', shot: { storyboard: 'n2' } } })
    expect(plan.segments).toEqual([{ storyboard: 'n2', index: 0, shots: ['s1', 's2', 's3', 's4', 's5'] }])
  })

  it('reuses the video node that already covers a segment and marks the others stale', () => {
    const board = boardNode('n2', ['s1', 's2', 's3', 's4', 's5'].map(shotId => shot(shotId)))
    const existing = videoNode('v1', 'n2', ['s1', 's2', 's3', 's4', 's5'], {
      versions: [{ id: 'v1' as never, path: '/a.mp4', createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
    })
    const orphan = videoNode('v2', 'n2', ['sx'], {
      versions: [{ id: 'v1' as never, path: '/b.mp4', createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
    })
    const plan = planNodes(documentOf([board, existing, orphan]), bible, ['n2'], limits)
    expect(plan.entries.map(entry => entry.node)).toEqual(['v1'])
    expect(plan.create).toEqual([])
    expect(plan.stale).toEqual(['v2'])
  })

  it('blocks a later segment until the segment before it has a tail frame', () => {
    const board = node('n2', 'storyboard', {
      versions: [{
        id: 'v1' as never, createdAt: 'now', origin: 'user',
        shots: [shot('s1'), shot('s2'), shot('s3'), shot('s4', { visual: '换场 邮局内' }), shot('s5'), shot('s6')],
      }],
      activeVersion: 'v1' as never,
    })
    const later = videoNode('v9', 'n2', ['s4', 's5', 's6'])
    const plan = planNodes(documentOf([board, later]), bible, ['v9'], limits)
    expect(plan.blocked).toEqual({
      gate: 'tail_chain',
      missing: ['v9 needs the tail frame of segment 0, which has not been generated'],
    })
  })

  it('refuses a storyboard whose shots miss what a video needs', () => {
    const board = node('n2', 'storyboard', {
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1', { shotSize: undefined as never })] }],
      activeVersion: 'v1' as never,
    })
    expect(planNodes(documentOf([board]), bible, ['n2'], limits).blocked).toEqual({
      gate: 'G2_storyboard_quality',
      missing: ['n2 shot s1: shotSize'],
    })
  })

  it('refuses a prompt that mentions bible entries when the project has no bible', () => {
    const image = node('n1', 'image', { gen: { kind: 'image', prompt: '画 @林夏', params: {} } })
    expect(planNodes(documentOf([image]), undefined, ['n1'], limits).blocked).toEqual({
      gate: 'G1_bible_first',
      missing: ['bible.json has no entries'],
    })
  })

  it('plans a single image node with its model default', () => {
    const image = node('n1', 'image', { gen: { kind: 'image', prompt: 'a cat', params: {} } })
    const plan = planNodes(documentOf([image]), bible, ['n1'], limits)
    expect(plan.entries).toEqual([{ node: 'n1', kind: 'image', model: 'image-model', calls: 1 }])
  })

  it('plans video, speech, and music nodes with their own defaults', () => {
    const video = node('n1', 'video', { gen: { kind: 'video', prompt: 'p', params: {} } })
    const speech = node('n2', 'audio', { gen: { kind: 'speech', prompt: 'p', params: {} } })
    const music = node('n3', 'audio', { gen: { kind: 'music', prompt: 'p', params: {} } })
    const plan = planNodes(documentOf([video, speech, music]), bible, ['n1', 'n2', 'n3'], limits)
    expect(plan.entries.map(entry => [entry.kind, entry.model, entry.lines])).toEqual([
      ['video', 'video-model', undefined],
      ['speech', 'speech-model', 1],
      ['music', 'music-model', undefined],
    ])
  })

  it('plans a storyboard without a version as one empty segment', () => {
    const board = node('n2', 'storyboard')
    const plan = planNodes(documentOf([board]), bible, ['n2'], limits)
    expect(plan.entries).toEqual([])
    expect(plan.segments).toEqual([])
  })

  it('chains the second segment from an existing tail frame and picks the frame model', () => {
    const board = node('n2', 'storyboard', {
      versions: [{
        id: 'v1' as never, createdAt: 'now', origin: 'user',
        shots: [shot('s1'), shot('s2'), shot('s3'), shot('s4'), shot('s5'), shot('s6')],
      }],
      activeVersion: 'v1' as never,
    })
    const first = videoNode('v1', 'n2', ['s1'], {
      versions: [{ id: 'v1' as never, path: '/a.mp4', createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
      tailOf: { node: 't1' as never, version: 'v1' as never },
    })
    const plan = planNodes(documentOf([board, first]), bible, ['n2'], limits)
    expect(plan.entries.map(entry => [entry.node, entry.model, entry.tailChain?.node])).toEqual([
      ['v1', 'video-ref-model', undefined],
      ['segment-1', 'video-model', 't1'],
    ])
  })

  it('accepts a prompt that mentions entries when the bible exists', () => {
    const image = node('n1', 'image', { gen: { kind: 'image', prompt: '画 @林夏', params: {} } })
    expect(planNodes(documentOf([image]), bible, ['n1'], limits).blocked).toBeUndefined()
  })

  it('reads a node without generation as having no prompt', () => {
    const document = documentOf([node('n1', 'text')])
    expect(collectInputs(document, document.nodes[0] as CanvasNode, bible).prompt).toBe('')
  })

  it('lets a later video generate when the storyboard has no version or the previous segment already has a tail', () => {
    const emptyBoard = node('n2', 'storyboard')
    const video = node('v9', 'video', {
      gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'n2' as never, shots: ['s1' as never] } },
    })
    expect(planNodes(documentOf([emptyBoard, video]), bible, ['v9'], limits).blocked).toBeUndefined()
  })

  it('lets a later video generate when the segment before it already has a tail', () => {
    const board = boardNode('n2', ['s1', 's2', 's3', 's4', 's5', 's6'].map(shotId => shot(shotId)))
    const first = videoNode('v1', 'n2', ['s1'], {
      versions: [{ id: 'v1' as never, path: '/a.mp4', createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
      tailOf: { node: 't1' as never, version: 'v1' as never },
    })
    const later = videoNode('v9', 'n2', ['s2', 's3', 's4', 's5', 's6'])
    expect(planNodes(documentOf([board, first, later]), bible, ['v9'], limits).blocked).toBeUndefined()
  })

  it('refuses a video whose storyboard is missing when it must chain', () => {
    const orphan = node('v9', 'video', {
      gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'n404' as never, shots: ['s1' as never] } },
    })
    expect(planNodes(documentOf([orphan]), bible, ['v9'], limits).blocked).toBeUndefined()
  })

  it('refuses nodes that do not exist or do not generate media', () => {
    const text = node('n1', 'text')
    expect(planNodes(documentOf([text]), bible, ['n9'], limits).blocked?.missing).toEqual(['node n9 does not exist'])
    expect(planNodes(documentOf([text]), bible, ['n1'], limits).blocked?.missing).toEqual(['node n1 does not generate media'])
  })
})

describe('mentions and reference images', () => {
  it('expands a mention into its description and adds the entry image as a reference', () => {
    const character = node('n1', 'image', {
      versions: [{ id: 'v1' as never, path: '/lin.png', createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
    })
    const video = node('n2', 'video', { gen: { kind: 'video', prompt: '中景 @林夏 站在雨里', params: {} } })
    const inputs = collectInputs(documentOf([character, video]), video, bible)
    expect(inputs.prompt).toBe('中景 林夏（店员） 站在雨里')
    expect(inputs.refs.map(ref => ref.path)).toEqual(['/lin.png'])
  })

  it('does not duplicate an image that an edge already provides', () => {
    const character = node('n1', 'image', {
      versions: [{ id: 'v1' as never, path: '/lin.png', createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
    })
    const video = node('n2', 'video', { gen: { kind: 'video', prompt: '@林夏', params: {} } })
    const document = documentOf([character, video], [
      { id: 'n1->n2:ref', source: 'n1' as never, target: 'n2' as never, kind: 'reference', role: 'ref' },
    ])
    expect(collectInputs(document, document.nodes[1] as CanvasNode, bible).refs.map(ref => ref.node)).toEqual(['n1'])
  })
})
