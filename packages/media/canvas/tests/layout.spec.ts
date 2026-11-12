import { describe, expect, it } from 'vitest'
import { fitGroups, layoutCreated, nodeSize, type DraftNode } from '../src/layout.ts'
import type { CanvasEdge } from '../src/types.ts'

function node(id: string, type: DraftNode['type'], overrides: Partial<DraftNode> = {}): DraftNode {
  return { id: id as DraftNode['id'], type, title: id, x: 0, y: 0, ...nodeSize(type === 'group' ? 'text' : type), ...overrides }
}

const edge = (source: string, target: string): CanvasEdge => ({
  id: `${source}->${target}`,
  source: source as CanvasEdge['source'],
  target: target as CanvasEdge['target'],
  kind: 'derivation',
})

describe('layout', () => {
  it('sizes every content kind', () => {
    expect(Object.fromEntries((['image', 'video', 'audio', 'text', 'script', 'storyboard', 'timeline'] as const)
      .map(type => [type, nodeSize(type)]))).toEqual({
      image: { width: 280, height: 280 },
      video: { width: 320, height: 220 },
      audio: { width: 280, height: 110 },
      text: { width: 280, height: 160 },
      script: { width: 320, height: 260 },
      storyboard: { width: 420, height: 300 },
      timeline: { width: 420, height: 260 },
    })
  })

  it('frames the members of a group and leaves an empty group alone', () => {
    const nodes = new Map<string, DraftNode>([
      ['g1', node('g1', 'group', { width: 1, height: 1 })],
      ['n1', node('n1', 'image', { x: 100, y: 100, group: 'g1' as never })],
      ['g2', node('g2', 'group', { width: 7, height: 9 })],
    ])
    fitGroups(nodes)
    expect(nodes.get('g1')).toMatchObject({ x: 70, y: 30, width: 280 + 60, height: 280 + 100 })
    expect(nodes.get('g2')).toMatchObject({ x: 0, y: 0, width: 7, height: 9 })
  })

  it('places a created node to the right of its source and avoids overlap', () => {
    const nodes = new Map<string, DraftNode>([
      ['n1', node('n1', 'image', { x: 0, y: 0, width: 100, height: 100 })],
      ['n2', node('n2', 'image', { x: 0, y: 0, width: 100, height: 100 })],
    ])
    layoutCreated(nodes, [edge('n1', 'n2')], ['n2'])
    expect(nodes.get('n2')?.x).toBe(180)
    expect(nodes.get('n2')?.y).toBe(0)
  })

  it('places a node without upstream or downstream beside its group members', () => {
    const nodes = new Map<string, DraftNode>([
      ['g1', node('g1', 'group')],
      ['n1', node('n1', 'text', { x: 0, y: 0, width: 100, height: 100, group: 'g1' as never })],
      ['n2', node('n2', 'text', { x: 0, y: 0, width: 100, height: 100, group: 'g1' as never })],
    ])
    layoutCreated(nodes, [], ['n2'])
    expect(nodes.get('n2')?.x).toBe(140)
  })

  it('places a node to the left of its downstream when the source comes later', () => {
    const nodes = new Map<string, DraftNode>([
      ['n1', node('n1', 'text', { x: 0, y: 0, width: 100, height: 100 })],
      ['n2', node('n2', 'text', { x: 400, y: 0, width: 100, height: 100 })],
    ])
    layoutCreated(nodes, [edge('n1', 'n2')], ['n1'])
    expect(nodes.get('n1')?.x).toBe(400 - 100 - 80)
  })

  it('falls back to a fresh column when nothing connects the created node', () => {
    const nodes = new Map<string, DraftNode>([
      ['n1', node('n1', 'text', { x: 10, y: 10, width: 100, height: 100 })],
      ['n2', node('n2', 'text', { x: 0, y: 0, width: 100, height: 100 })],
      ['n3', node('n3', 'text', { x: 0, y: 0, width: 100, height: 100 })],
    ])
    layoutCreated(nodes, [], ['n2', 'n3'])
    expect(nodes.get('n2')?.y).toBeGreaterThanOrEqual(110)
    expect(nodes.get('n3')?.x).toBeGreaterThan(nodes.get('n2')?.x ?? 0)
  })

  it('forces a place for a node whose source is also being created', () => {
    const nodes = new Map<string, DraftNode>([
      ['n1', node('n1', 'text', { x: 0, y: 0, width: 100, height: 100 })],
      ['n2', node('n2', 'text', { x: 0, y: 0, width: 100, height: 100 })],
    ])
    layoutCreated(nodes, [edge('n1', 'n2')], ['n1', 'n2'])
    expect(nodes.get('n1')?.y).toBeGreaterThanOrEqual(0)
    expect(nodes.get('n2')?.x).toBeGreaterThanOrEqual(0)
  })

  it('ignores ids that are not in the map', () => {
    const nodes = new Map<string, DraftNode>()
    layoutCreated(nodes, [], ['n9'])
    expect(nodes.size).toBe(0)
  })
})

describe('storyboard layout', () => {
  it('lays out six scenes without overlapping', async () => {
    const { resolveConfig } = await import('../src/config.ts')
    const { EMPTY_CANVAS } = await import('../src/document.ts')
    const { applyOperations } = await import('../src/operations.ts')
    const operations = Array.from({ length: 6 }, (_unused, index) => {
      const scene = index + 1
      return [
        { op: 'add' as const, ref: `text${String(scene)}`, type: 'text' as const, title: `场${String(scene)}`, text: `body ${String(scene)}` },
        { op: 'add' as const, ref: `board${String(scene)}`, type: 'storyboard' as const, title: `场${String(scene)} 分镜`, shots: [] },
        { op: 'group' as const, ref: `group${String(scene)}`, title: `场${String(scene)}`, nodes: [`text${String(scene)}`, `board${String(scene)}`] },
        { op: 'connect' as const, from: `text${String(scene)}`, to: `board${String(scene)}`, role: 'prompt' as const },
      ]
    }).flat()
    const { document } = applyOperations(EMPTY_CANVAS, operations, { limits: resolveConfig({}) })
    const content = document.nodes.filter(node => node.type !== 'group')
    for (const [index, left] of content.entries()) {
      for (const right of content.slice(index + 1)) {
        const overlaps = left.x < right.x + right.width && right.x < left.x + left.width
          && left.y < right.y + right.height && right.y < left.y + left.height
        expect(overlaps, `${left.id} overlaps ${right.id}`).toBe(false)
      }
    }
  })
})
