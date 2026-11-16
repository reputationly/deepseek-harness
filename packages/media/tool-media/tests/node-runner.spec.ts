import { describe, expect, it } from 'vitest'
import type { Bible, CanvasDocument, CanvasNode, Shot } from '@deepseek-ai/dsh-canvas'
import { adoptedTailOf, collectInputs, planNodes, segmentPrompt, type PlanLimits } from '../src/node-runner.ts'

const limits: PlanLimits = {
  maxVideoSeconds: 15,
  minVideoSeconds: 4,
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

type StoredShot = Omit<Shot, 'shotSize'> & Partial<Pick<Shot, 'shotSize'>>

const boardNode = (id: string, shots: readonly StoredShot[]): CanvasNode => node(id, 'storyboard', {
  versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: shots as readonly Shot[] }],
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
  version: 3, revision: 0, nextId: nodes.length + 1, nodes, edges,
})

it('resolves the tail of the adopted video across newer candidates and explicit adoption', () => {
  const video = videoNode('v1', 'board', ['s1'], {
    activeVersion: 'old' as never,
    versions: [
      { id: 'old' as never, path: '/old.mp4', origin: 'agent', createdAt: 'now' },
      { id: 'new' as never, path: '/new.mp4', origin: 'agent', createdAt: 'now' },
    ],
    tailOf: { node: 'tail' as never, version: 'new-tail' as never, sourceVersion: 'new' as never },
  })
  const frame = node('tail', 'image', { versions: [
    { id: 'old-tail' as never, path: '/old.png', origin: 'agent', createdAt: 'now', inputs: [{ node: video.id, version: 'old' as never, path: '/old.mp4', role: 'source' }] },
    { id: 'new-tail' as never, path: '/new.png', origin: 'agent', createdAt: 'now', inputs: [{ node: video.id, version: 'new' as never, path: '/new.mp4', role: 'source' }] },
  ] })
  const document = documentOf([video, frame], [{ id: 'derived', source: video.id, target: frame.id, kind: 'derivation' }])
  expect(adoptedTailOf(document, video)).toMatchObject({ version: 'old-tail', path: '/old.png' })
  expect(adoptedTailOf(document, { ...video, activeVersion: 'new' as never })).toMatchObject({ version: 'new-tail', path: '/new.png' })
  expect(adoptedTailOf(document, node('v1', 'video', { versions: video.versions ?? [] }))).toBeUndefined()
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
    expect(() => collectInputs(document, document.nodes[1] as CanvasNode, bible)).toThrow('no adopted media')
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
  it('plans one keyframe and one video per segment and creates the missing nodes', () => {
    const board = boardNode('n2', ['s1', 's2', 's3', 's4', 's5'].map(shotId => shot(shotId)))
    const plan = planNodes(documentOf([board]), bible, ['n2'], limits, { aspect: '9:16', resolution: '1K' })
    expect(plan.blocked).toBeUndefined()
    // One segment: the video entry then its keyframe entry.
    expect(plan.entries.map(entry => [entry.kind, entry.seconds, entry.model, entry.shots?.length])).toEqual([
      ['video', 15, 'video-model', 5],
      ['image', undefined, 'image-model', undefined],
    ])
    const adds = plan.create.filter(op => op.op === 'add')
    expect(adds).toHaveLength(2)
    expect(adds[0]).toMatchObject({
      op: 'add', type: 'image', title: 'n2 · 段1 分镜图',
      gen: { kind: 'image', model: 'image-model', params: { size: '1024x1824' }, shot: { storyboard: 'n2' } },
    })
    expect(adds[1]).toMatchObject({ op: 'add', type: 'video', title: 'n2 · 段1', gen: { kind: 'video', shot: { storyboard: 'n2' } } })
    expect(plan.create).toContainEqual({ op: 'connect', from: 'keyframe-n2-0', to: 'segment-n2-0', kind: 'reference', role: 'first_frame' })
    expect(plan.segments).toEqual([{ storyboard: 'n2', index: 0, shots: ['s1', 's2', 's3', 's4', 's5'] }])
  })

  it('raises a sub-minimum segment to the shortest requested clip', () => {
    const board = boardNode('n2', [shot('s1')])
    const plan = planNodes(documentOf([board]), bible, ['n2'], limits)
    const video = plan.entries.find(entry => entry.kind === 'video')
    expect(video?.seconds).toBe(4)
    expect(plan.create.find(op => op.op === 'add' && op.type === 'video')).toMatchObject({ gen: { params: { duration: 4 } } })
  })

  it('keeps a sub-minimum segment when the configured floor is lower', () => {
    const board = boardNode('n2', [shot('s1')])
    const plan = planNodes(documentOf([board]), bible, ['n2'], { ...limits, minVideoSeconds: 2 })
    const video = plan.entries.find(entry => entry.kind === 'video')
    expect(video?.seconds).toBe(3)
    expect(plan.create.find(op => op.op === 'add' && op.type === 'video')).toMatchObject({ gen: { params: { duration: 3 } } })
  })

  it('still caps an over-long segment at the maximum', () => {
    const board = boardNode('n2', [shot('s1', { durationSec: 20 })])
    const plan = planNodes(documentOf([board]), bible, ['n2'], limits)
    const video = plan.entries.find(entry => entry.kind === 'video')
    expect(video?.seconds).toBe(15)
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
    expect(plan.entries.filter(entry => entry.kind === 'video').map(entry => entry.node)).toEqual(['v1'])
    expect(plan.stale).toEqual(['v2'])
  })

  it('plans a prompt update for a reused segment without mutating the canvas', () => {
    const board = boardNode('n2', [shot('s1', { shotSize: 'medium' })])
    const oldPrompt = '0–3s [close] 画面 s1。动作：动作。运镜：固定。避免：水印'
    const original = videoNode('v1', 'n2', ['s1'])
    if (original.gen === undefined) throw new Error('video fixture has no generation spec')
    const existing = { ...original, gen: { ...original.gen, prompt: oldPrompt } }
    const plan = planNodes(documentOf([board, existing]), bible, ['n2'], limits)
    const prompt = segmentPrompt([shot('s1')], bible)
    expect(plan.edits).toEqual([{ op: 'set_gen', node: 'v1', gen: { prompt } }])
    expect(existing.gen?.prompt).toBe(oldPrompt)
  })

  it('does not require a preceding tail for a scene cut', () => {
    const board = node('n2', 'storyboard', {
      versions: [{
        id: 'v1' as never, createdAt: 'now', origin: 'user',
        shots: [shot('s1'), shot('s2'), shot('s3'), shot('s4', { visual: '换场 邮局内' }), shot('s5'), shot('s6')],
      }],
      activeVersion: 'v1' as never,
    })
    const later = videoNode('v9', 'n2', ['s4', 's5', 's6'])
    const plan = planNodes(documentOf([board, later]), bible, ['v9'], limits)
    expect(plan.blocked).toBeUndefined()
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

  it.each(['image', 'video', 'storyboard'] as const)('refuses %s generation without a bible even when the prompt has no mention', (type) => {
    const requested = node('n1', type, { gen: { kind: type === 'storyboard' ? 'video' : type, prompt: 'a street', params: {} } })
    expect(planNodes(documentOf([requested]), undefined, ['n1'], limits).blocked?.gate).toBe('G1_bible_first')
  })

  it('rechecks storyboard quality when retrying its video node directly', () => {
    const { shotSize: _removed, ...invalid } = shot('s1')
    const board = boardNode('n2', [invalid])
    const video = videoNode('v1', 'n2', ['s1'])
    expect(planNodes(documentOf([board, video]), bible, ['v1'], limits).blocked).toEqual({
      gate: 'G2_storyboard_quality', missing: ['n2 shot s1: shotSize'],
    })
  })

  it('plans a single image node with its model default', () => {
    const image = node('n1', 'image', { gen: { kind: 'image', prompt: 'a cat', params: {} } })
    const plan = planNodes(documentOf([image]), bible, ['n1'], limits)
    expect(plan.entries).toEqual([{ node: 'n1', kind: 'image', model: 'image-model', calls: 1, lines: 1 }])
  })

  it('plans video, speech, and music nodes with their own defaults', () => {
    const video = node('n1', 'video', { gen: { kind: 'video', prompt: 'p', params: {} } })
    const speech = node('n2', 'audio', { gen: { kind: 'speech', prompt: 'p', params: {} } })
    const music = node('n3', 'audio', { gen: { kind: 'music', prompt: 'p', params: {} } })
    const plan = planNodes(documentOf([video, speech, music]), bible, ['n1', 'n2', 'n3'], limits)
    expect(plan.entries.map(entry => [entry.kind, entry.model, entry.lines])).toEqual([
      ['video', 'video-model', 1],
      ['speech', 'speech-model', 1],
      ['music', 'music-model', 1],
    ])
  })

  it('plans a storyboard without a version as one empty segment', () => {
    const board = node('n2', 'storyboard')
    const plan = planNodes(documentOf([board]), bible, ['n2'], limits)
    expect(plan.entries).toEqual([])
    expect(plan.segments).toEqual([])
  })

  it('fans a scene out from its first keyframe and gives continuous segments a last frame', () => {
    const board = node('n2', 'storyboard', {
      versions: [{
        id: 'v1' as never, createdAt: 'now', origin: 'user',
        shots: [shot('s1'), shot('s2'), shot('s3'), shot('s4'), shot('s5'), shot('s6')],
      }],
      activeVersion: 'v1' as never,
    })
    const tight = { ...limits, maxVideoSeconds: 9 }
    const plan = planNodes(documentOf([board]), bible, ['n2'], tight)
    const count = plan.segments.length
    expect(count).toBeGreaterThan(1)
    const videos = plan.entries.filter(entry => entry.kind === 'video')
    const images = plan.entries.filter(entry => entry.kind === 'image')
    expect(videos).toHaveLength(count)
    expect(images).toHaveLength(count)
    expect(videos.every(entry => entry.model === 'video-model')).toBe(true)
    expect(images.every(entry => entry.model === 'image-model')).toBe(true)
    // Every keyframe after the first waits on the scene's first keyframe; every video waits on
    // its own keyframe, plus the next keyframe when that segment continues this one.
    const keyIds = images.map(entry => entry.ref ?? entry.node)
    expect(images[0]?.after).toBeUndefined()
    for (const [index, image] of images.entries()) {
      if (index > 0) expect(image.after).toEqual([keyIds[0]])
    }
    const videoAfter = videos.map(entry => entry.after ?? [])
    expect(videoAfter.every(after => after.length >= 1)).toBe(true)
    // Edges: one ref into each later keyframe, one first_frame into each video, and a last_frame
    // into each video whose next segment continues it.
    const connects = plan.create.filter(op => op.op === 'connect')
    expect(connects.filter(op => op.role === 'ref')).toHaveLength(count - 1)
    expect(connects.filter(op => op.role === 'first_frame')).toHaveLength(count)
    const lastFrames = connects.filter(op => op.role === 'last_frame')
    // A video carries a last frame exactly when its `after` lists its own keyframe plus the next one.
    const withLastFrame = videos.filter(entry => (entry.after ?? []).length === 2).length
    expect(lastFrames).toHaveLength(withLastFrame)
    // No video carries bible reference edges.
    expect(connects.some(op => op.role === 'ref' && op.to.includes('segment-'))).toBe(false)
  })

  it('accepts a prompt that mentions entries when the bible exists', () => {
    const image = node('n1', 'image', { gen: { kind: 'image', prompt: '画 @林夏', params: {} } })
    expect(planNodes(documentOf([image]), bible, ['n1'], limits).blocked).toBeUndefined()
  })

  it('reads a node without generation as having no prompt', () => {
    const document = documentOf([node('n1', 'text')])
    expect(collectInputs(document, document.nodes[0] as CanvasNode, bible).prompt).toBe('')
  })

  it('refuses a video referring to shots that its storyboard no longer has', () => {
    const emptyBoard = node('n2', 'storyboard')
    const video = node('v9', 'video', {
      gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'n2' as never, shots: ['s1' as never] } },
    })
    expect(planNodes(documentOf([emptyBoard, video]), bible, ['v9'], limits).blocked).toEqual({
      gate: 'G2_storyboard_quality', missing: ['n2 shot s1 does not exist'],
    })
  })

  it('plans the missing keyframes when a single segment video regenerates', () => {
    const board = boardNode('n2', ['s1', 's2', 's3', 's4', 's5', 's6'].map(shotId => shot(shotId)))
    // Six 3s shots at the default 15s cap make one segment; force two segments with a lower cap.
    const tight = { ...limits, maxVideoSeconds: 9 }
    const later = videoNode('v9', 'n2', ['s4', 's5', 's6'])
    const plan = planNodes(documentOf([board, later]), bible, ['v9'], tight)
    expect(plan.blocked).toBeUndefined()
    // The second segment's video needs its own keyframe, the scene's first keyframe, and—because
    // segment 2 continues segment 1—the next segment does not exist so no last frame is planned.
    const images = plan.entries.filter(entry => entry.kind === 'image')
    expect(images.length).toBeGreaterThan(0)
    const video = plan.entries.find(entry => entry.kind === 'video' && entry.node === 'v9')
    expect(video?.after?.length).toBeGreaterThan(0)
  })

  it('refuses a video whose storyboard is missing when it must chain', () => {
    const orphan = node('v9', 'video', {
      gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'n404' as never, shots: ['s1' as never] } },
    })
    expect(planNodes(documentOf([orphan]), bible, ['v9'], limits).blocked).toEqual({
      gate: 'G2_storyboard_quality', missing: ['v9 storyboard n404 does not exist'],
    })
  })

  it('refuses nodes that do not exist or do not generate media by name', () => {
    const text = node('n1', 'text')
    expect(() => planNodes(documentOf([text]), bible, ['n9'], limits)).toThrow('canvas node n9 does not exist')
    expect(() => planNodes(documentOf([text]), bible, ['n1'], limits)).toThrow('canvas node n1 does not generate media')
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

describe('mention resolution details', () => {
  it('matches an alias, keeps an unknown mention, and skips an entry without a usable image', () => {
    const aliased: Bible = {
      version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' },
      entries: [
        { id: 'c1' as never, kind: 'character', name: '林夏', aliases: ['小林'], description: '店员', imageNodes: [] },
        { id: 'c2' as never, kind: 'character', name: '陈默', aliases: [], description: '客人', imageNodes: ['n404' as never] },
      ],
    }
    const video = node('n2', 'video', { gen: { kind: 'video', prompt: '@小林 与 @陈默 与 @无名', params: {} } })
    const inputs = collectInputs(documentOf([video]), video, aliased)
    expect(inputs.prompt).toBe('林夏（店员） 与 陈默（客人） 与 @无名')
    expect(inputs.refs).toEqual([])
  })
})
