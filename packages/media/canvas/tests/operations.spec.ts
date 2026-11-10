import { describe, expect, it } from 'vitest'
import { EMPTY_CANVAS } from '../src/document.ts'
import { applyOperations } from '../src/operations.ts'
import type { CanvasDocument, CanvasOperation } from '../src/types.ts'

function build(operations: readonly CanvasOperation[], from: CanvasDocument = EMPTY_CANVAS) {
  return applyOperations(from, operations)
}

function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

describe('applyOperations', () => {
  it('creates, connects, and groups nodes of one call through refs', () => {
    const { document, result, changed } = build([
      { op: 'add', ref: 'brief', type: 'text', title: 'Brief', text: 'A cat brand' },
      { op: 'add', ref: 'a', type: 'text', text: 'Option A' },
      { op: 'add', ref: 'b', type: 'text', text: 'Option B' },
      { op: 'connect', from: 'brief', to: 'a' },
      { op: 'connect', from: 'brief', to: 'b' },
      { op: 'group', ref: 'options', title: 'Options', nodes: ['a', 'b'] },
    ])
    expect(changed).toBe(true)
    expect(result).toEqual({ refs: { brief: 'n1', a: 'n2', b: 'n3', options: 'g4' }, created: ['n1', 'n2', 'n3', 'g4'], skipped: [] })
    expect(document.nextId).toBe(5)
    expect(document.edges).toEqual([
      { id: 'n1->n2', source: 'n1', target: 'n2', kind: 'reference' },
      { id: 'n1->n3', source: 'n1', target: 'n3', kind: 'reference' },
    ])
    const [brief, a, b, group] = document.nodes
    expect(a?.group).toBe('g4')
    expect(b?.group).toBe('g4')
    expect(a?.x).toBeGreaterThan((brief?.x ?? 0) + (brief?.width ?? 0))
    expect(b?.x).toBe(a?.x)
    expect(b?.y).toBeGreaterThan((a?.y ?? 0) + (a?.height ?? 0))
    expect(group).toMatchObject({ type: 'group', title: 'Options' })
    expect(group?.x).toBeLessThan(a?.x ?? 0)
    expect((group?.y ?? 0) + (group?.height ?? 0)).toBeGreaterThan((b?.y ?? 0) + (b?.height ?? 0))
    expect(overlap(brief!, group!)).toBe(false)
  })

  it('skips operations that cannot apply and applies the rest', () => {
    const base = build([
      { op: 'add', type: 'text', text: 'one' },
      { op: 'add', type: 'text', text: 'two' },
      { op: 'connect', from: 'n1', to: 'n2' },
    ]).document
    const { document, result } = build([
      { op: 'connect', from: 'n1', to: 'n9' },
      { op: 'connect', from: 'n1', to: 'n2' },
      { op: 'connect', from: 'n2', to: 'n1' },
      { op: 'connect', from: 'n1', to: 'n1' },
      { op: 'add', type: 'text' },
      { op: 'add', type: 'image' },
      { op: 'update', node: 'n1', path: '/tmp/a.png' },
      { op: 'group', nodes: [] },
      { op: 'ungroup', node: 'n1' },
      { op: 'disconnect', from: 'n2', to: 'n1' },
      { op: 'update', node: 'n2', title: 'Second' },
    ], base)
    expect(result.skipped.map(skip => [skip.index, skip.op, skip.reason])).toEqual([
      [0, 'connect', 'node n9 does not exist'],
      [1, 'connect', 'n1 is already connected to n2'],
      [2, 'connect', 'connecting n2 to n1 would create a cycle'],
      [3, 'connect', 'a node cannot connect to itself'],
      [4, 'add', 'a text node needs text'],
      [5, 'add', 'an image node needs path'],
      [6, 'update', 'node n1 has no file'],
      [7, 'group', 'a group needs at least one node'],
      [8, 'ungroup', 'node n1 is not a group'],
      [9, 'disconnect', 'n2->n1 is not connected'],
    ])
    expect(document.nodes.find(node => node.id === 'n2')?.title).toBe('Second')
    expect(document.nodes).toHaveLength(2)
  })

  it('reports no change when every operation is skipped or refused', () => {
    const { changed, result } = applyOperations(EMPTY_CANVAS, [{ op: 'remove', node: 'n1' }, { op: 'add', type: 'image', path: '/x.png' }], new Map([[1, 'file /x.png does not exist']]))
    expect(changed).toBe(false)
    expect(result.skipped).toEqual([
      { index: 0, op: 'remove', reason: 'node n1 does not exist' },
      { index: 1, op: 'add', reason: 'file /x.png does not exist' },
    ])
  })

  it('keeps existing nodes in place and puts a derived node to the right of its sources', () => {
    const base = build([
      { op: 'add', type: 'image', path: '/a.png' },
      { op: 'add', type: 'image', path: '/b.png' },
      { op: 'group', title: 'Refs', nodes: ['n1', 'n2'] },
    ]).document
    const moved = build([{ op: 'move', node: 'n1', x: 500, y: 500 }], base).document
    expect(moved.nodes.find(node => node.id === 'n1')).toMatchObject({ x: 500, y: 500, placed: true })
    const { document, result } = build([
      { op: 'add', ref: 'out', type: 'image', path: '/out.png', prompt: 'merge', model: 'm' },
      { op: 'connect', from: 'g3', to: 'out', kind: 'derivation' },
    ], moved)
    const before = new Map(moved.nodes.filter(node => node.type !== 'group').map(node => [node.id, node]))
    for (const node of document.nodes) if (before.has(node.id)) expect(node).toEqual(before.get(node.id))
    const group = document.nodes.find(node => node.id === 'g3')
    const out = document.nodes.find(node => node.id === result.refs.out)
    expect(out).toMatchObject({ type: 'image', title: 'out.png', prompt: 'merge', model: 'm' })
    expect(out?.x).toBeGreaterThanOrEqual((group?.x ?? 0) + (group?.width ?? 0))
    expect(document.edges).toEqual([{ id: 'g3->n4', source: 'g3', target: 'n4', kind: 'derivation' }])
  })

  it('lays unconnected nodes out in a row below existing content without overlap', () => {
    const base = build([{ op: 'add', type: 'text', text: 'first' }]).document
    const { document } = build([
      { op: 'add', type: 'text', text: 'second' },
      { op: 'add', type: 'text', text: 'third' },
    ], base)
    const [first, second, third] = document.nodes
    expect(second?.y).toBeGreaterThan((first?.y ?? 0) + (first?.height ?? 0))
    expect(third?.y).toBe(second?.y)
    expect(third?.x).toBeGreaterThan((second?.x ?? 0) + (second?.width ?? 0))
  })

  it('removes a node with its edges, drops an emptied group, and never reuses ids', () => {
    const base = build([
      { op: 'add', type: 'text', text: 'one' },
      { op: 'add', type: 'text', text: 'two' },
      { op: 'connect', from: 'n1', to: 'n2' },
      { op: 'group', nodes: ['n2'] },
    ]).document
    const { document } = build([{ op: 'remove', node: 'n2' }, { op: 'add', type: 'text', text: 'three' }], base)
    expect(document.nodes.map(node => node.id)).toEqual(['n1', 'n4'])
    expect(document.edges).toEqual([])
  })

  it('moves a group by moving its members and dissolves it on ungroup', () => {
    const base = build([
      { op: 'add', type: 'text', text: 'one' },
      { op: 'add', type: 'text', text: 'two' },
      { op: 'group', nodes: ['n1', 'n2'] },
    ]).document
    const group = base.nodes.find(node => node.id === 'g3')
    const moved = build([{ op: 'move', node: 'g3', x: (group?.x ?? 0) + 100, y: (group?.y ?? 0) + 50 }], base).document
    expect(moved.nodes.find(node => node.id === 'n1')?.x).toBe((base.nodes.find(node => node.id === 'n1')?.x ?? 0) + 100)
    expect(moved.nodes.find(node => node.id === 'g3')?.y).toBe((group?.y ?? 0) + 50)
    const { document, result } = build([{ op: 'resize', node: 'g3', width: 1, height: 1 }, { op: 'resize', node: 'n1', width: 400, height: 300 }, { op: 'ungroup', node: 'g3' }], moved)
    expect(result.skipped).toEqual([{ index: 0, op: 'resize', reason: 'a group frame follows its members' }])
    expect(document.nodes.map(node => [node.id, node.group, node.width])).toEqual([['n1', undefined, 400], ['n2', undefined, 280]])
  })
})
