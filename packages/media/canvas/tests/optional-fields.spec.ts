import { describe, expect, it } from 'vitest'
import { parseCanvas } from '../src/document.ts'
import { layoutCreated, nodeSize, type DraftNode } from '../src/layout.ts'
import type { CanvasEdge } from '../src/types.ts'

const shot = {
  id: 's1', title: 'shot', shotSize: 'close', visual: 'v', motion: 'm', camera: 'c', durationSec: 2,
  characters: ['c1'], scene: 'l1', props: ['p1'],
  dialogue: [
    { id: 'd1', speaker: { kind: 'character', entry: 'c1' }, line: 'hi' },
    { id: 'd2', speaker: { kind: 'narrator' }, line: 'aside' },
  ],
  sfx: 'rain', negative: 'blur',
  still: { type: 'zoom_in', strength: 0.5 },
  beat: { fromMs: 0, toMs: 500 },
}

const documentOf = (node: Record<string, unknown>): string => JSON.stringify({
  version: 2, revision: 0, nextId: 2, nodes: [{ id: 'n1', type: 'storyboard', title: 'board', x: 0, y: 0, width: 1, height: 1, ...node }], edges: [],
})

describe('optional document fields', () => {
  it('parses a shot with a still move, a beat, both speaker kinds, and inputs', () => {
    const document = parseCanvas(documentOf({
      versions: [{ id: 'v1', shots: [shot], inputs: [{ node: 'n1', version: 'v2', role: 'ref', path: '/a.png' }], createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1',
      gen: {
        kind: 'video', prompt: 'p', params: {},
        shot: { storyboard: 'n1', shots: ['s1'] },
        dialogue: { storyboard: 'n1', shot: 's1', line: 'd1' },
      },
    }))
    const version = document.nodes[0]?.versions?.[0]
    expect(version?.shots?.[0]?.still).toEqual({ type: 'zoom_in', strength: 0.5 })
    expect(version?.shots?.[0]?.beat).toEqual({ fromMs: 0, toMs: 500 })
    expect(version?.inputs?.[0]?.role).toBe('ref')
    expect(document.nodes[0]?.gen?.shot).toEqual({ storyboard: 'n1', shots: ['s1'] })
    expect(document.nodes[0]?.gen?.dialogue?.line).toBe('d1')
  })

  it('parses a still without a beat and a shot without optional lists', () => {
    const { beat: _beat, still, ...withoutBeat } = shot
    const document = parseCanvas(documentOf({
      versions: [{
        id: 'v1',
        shots: [{
          ...withoutBeat, still, dialogue: [],
          characters: [], props: [],
        }],
        createdAt: 'now', origin: 'user',
      }],
    }))
    expect(document.nodes[0]?.versions?.[0]?.shots?.[0]?.beat).toBeUndefined()
    expect(document.nodes[0]?.versions?.[0]?.shots?.[0]?.scene).toBe('l1')
  })

  it('rejects a still whose strength is outside its range', () => {
    expect(() => parseCanvas(documentOf({
      versions: [{ id: 'v1', shots: [{ ...shot, still: { type: 'zoom_in', strength: 2 } }], createdAt: 'now', origin: 'user' }],
    }))).toThrow('outside 0–1')
  })

  it('rejects a failed status without a retryable flag', () => {
    expect(() => parseCanvas(documentOf({ status: { state: 'failed', at: 'now', error: 'x' } })))
      .toThrow('retryable is not a boolean')
  })

  it('rejects a JSON document that is not an object', () => {
    expect(() => parseCanvas('null')).toThrow('document is not an object')
    expect(() => parseCanvas('true')).toThrow('document is not an object')
  })
})

describe('layout edge cases', () => {
  const draft = (id: string, type: DraftNode['type'], extra: Partial<DraftNode> = {}): DraftNode => ({
    id: id as DraftNode['id'], type, title: id, x: 0, y: 0, ...nodeSize(type === 'group' ? 'text' : type), ...extra,
  })
  const edge = (source: string, target: string): CanvasEdge => ({
    id: `${source}->${target}`, source: source as CanvasEdge['source'], target: target as CanvasEdge['target'], kind: 'derivation',
  })

  it('waits for an unknown source and then places the node anyway', () => {
    const nodes = new Map<string, DraftNode>([['n1', draft('n1', 'text')]])
    layoutCreated(nodes, [edge('n9', 'n1')], ['n1'])
    expect(nodes.get('n1')?.x).toBeGreaterThanOrEqual(0)
  })

  it('measures a group with no members by its own frame', () => {
    const nodes = new Map<string, DraftNode>([
      ['g1', draft('g1', 'group', { width: 10, height: 10 })],
      ['n1', draft('n1', 'text')],
    ])
    layoutCreated(nodes, [edge('g1', 'n1')], ['n1'])
    expect(nodes.get('n1')?.x).toBe(90)
  })

  it('drops a pending id that is not in the map', () => {
    const nodes = new Map<string, DraftNode>()
    layoutCreated(nodes, [], ['n9'])
    expect(nodes.size).toBe(0)
  })
})

describe('deployment bounds on versions', () => {
  it('rejects a version prompt and a version storyboard that exceed the bounds', async () => {
    const { assertWithinLimits } = await import('../src/document.ts')
    const { resolveConfig } = await import('../src/config.ts')
    const document = parseCanvas(documentOf({
      versions: [{ id: 'v1', prompt: 'long prompt', createdAt: 'now', origin: 'user' }],
    }))
    expect(() => assertWithinLimits(document, resolveConfig({ maxPromptLength: 3 }))).toThrow('version v1 prompt')
    const board = parseCanvas(documentOf({
      versions: [{ id: 'v1', shots: [shot, shot], createdAt: 'now', origin: 'user' }],
    }))
    expect(() => assertWithinLimits(board, resolveConfig({ maxShotsPerStoryboard: 1 }))).toThrow('storyboard exceeds')
  })
})

describe('parse boundaries', () => {
  it('rejects a negative revision, a missing edge endpoint, and a bad order', () => {
    expect(() => parseCanvas(JSON.stringify({ version: 2, revision: -1, nextId: 1, nodes: [], edges: [] }))).toThrow('revision')
    expect(() => parseCanvas(JSON.stringify({
      version: 2, revision: 0, nextId: 2,
      nodes: [{ id: 'n1', type: 'image', title: 'a', x: 0, y: 0, width: 1, height: 1 }],
      edges: [{ id: 'n1->n2', source: 'n1', target: 'n2', kind: 'derivation' }],
    }))).toThrow('missing node')
    expect(() => parseCanvas(JSON.stringify({
      version: 2, revision: 0, nextId: 3,
      nodes: [
        { id: 'n1', type: 'image', title: 'a', x: 0, y: 0, width: 1, height: 1 },
        { id: 'n2', type: 'video', title: 'b', x: 0, y: 0, width: 1, height: 1 },
      ],
      edges: [{ id: 'n1->n2:ref', source: 'n1', target: 'n2', kind: 'reference', role: 'ref', order: -1 }],
    }))).toThrow('order')
  })

  it('parses inputs without a role and generation without model or parameters', () => {
    const document = parseCanvas(documentOf({
      gen: { kind: 'video', prompt: 'p' },
      versions: [{ id: 'v1', inputs: [{ node: 'n1', version: 'v2', path: '/a.png' }], createdAt: 'now', origin: 'user' }],
    }))
    expect(document.nodes[0]?.versions?.[0]?.inputs?.[0]?.role).toBeUndefined()
    expect(document.nodes[0]?.gen?.params).toEqual({})
    expect(document.nodes[0]?.gen?.model).toBeUndefined()
  })
})
