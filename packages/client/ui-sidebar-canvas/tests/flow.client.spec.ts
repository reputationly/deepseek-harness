/** The document maps onto a flow with members inside their group, and gestures map back onto canvas edits. */
import { expect, it } from 'vitest'
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import { deleteOperations, flowEdges, flowNodes, groupable, keepSelection, moveOperations } from '../src/client/flow.ts'

const face = { readFile: async () => ({ ok: false as const, message: 'unused' }), t: (key: string) => key, edit: async () => {} }

const version = { id: 'v1' as never, createdAt: 'now', origin: 'user' as const }

const document: CanvasDocument = {
  version: 2,
  revision: 0,
  nextId: 6,
  nodes: [
    { id: 'n1' as never, type: 'text', title: 'Brief', x: 0, y: 0, width: 280, height: 160, activeVersion: 'v1' as never, versions: [{ ...version, text: 'brief' }] },
    { id: 'n2' as never, type: 'image', title: 'a.png', x: 360, y: 40, width: 280, height: 280, group: 'g4' as never, activeVersion: 'v1' as never, versions: [{ ...version, path: '/p/a.png' }] },
    { id: 'n3' as never, type: 'image', title: 'b.png', x: 360, y: 360, width: 280, height: 280, group: 'g4' as never, activeVersion: 'v1' as never, versions: [{ ...version, path: '/p/b.png' }] },
    { id: 'g4' as never, type: 'group', title: 'Candidates', x: 330, y: -30, width: 340, height: 700, versions: [] },
    { id: 'n5' as never, type: 'video', title: 'out.mp4', x: 760, y: 0, width: 320, height: 220, activeVersion: 'v1' as never, versions: [{ ...version, path: '/p/out.mp4' }] },
  ],
  edges: [
    { id: 'n1->n2:prompt', source: 'n1' as never, target: 'n2' as never, kind: 'reference', role: 'prompt' },
    { id: 'g4->n5', source: 'g4' as never, target: 'n5' as never, kind: 'derivation' },
  ],
}

it('draws groups before their members and positions members inside the group', () => {
  const nodes = flowNodes(document, face)
  expect(nodes.map(node => [node.id, node.type, node.parentId, node.position, node.width, node.height])).toEqual([
    ['g4', 'frame', undefined, { x: 330, y: -30 }, 340, 700],
    ['n1', 'text', undefined, { x: 0, y: 0 }, 280, 160],
    ['n2', 'image', 'g4', { x: 30, y: 70 }, 280, 280],
    ['n3', 'image', 'g4', { x: 30, y: 390 }, 280, 280],
    ['n5', 'video', undefined, { x: 760, y: 0 }, 320, 220],
  ])
  expect(nodes[2]?.data).toEqual({ node: document.nodes[1], ...face })
})

it('draws each role with its own style and label', () => {
  const t = (key: string, params?: Record<string, unknown>) => `${key}:${String(params?.n ?? '')}`
  const edges = flowEdges(document, t as never)
  expect(edges[0]).toMatchObject({
    id: 'n1->n2:prompt', source: 'n1', target: 'n2', label: 'edge.prompt:1',
    style: { strokeDasharray: '6 4', stroke: 'var(--dsh-color-border-strong)' },
  })
  expect(edges[1]).toMatchObject({ id: 'g4->n5', source: 'g4', target: 'n5' })
  expect(edges[1]?.style?.strokeDasharray).toBeUndefined()
})

it('keeps the selection of items that survive a redraw', () => {
  const previous = [{ id: 'n1', selected: true }, { id: 'gone', selected: true }, { id: 'n2' }]
  expect(keepSelection([{ id: 'n1' }, { id: 'n2' }, { id: 'n5' }], previous)).toEqual([{ id: 'n1', selected: true }, { id: 'n2' }, { id: 'n5' }])
})

it('records where nodes were dropped in canvas coordinates', () => {
  expect(moveOperations(document, [
    { id: 'n1', position: { x: 12.4, y: -7.6 } },
    { id: 'n2', position: { x: 50, y: 70 } },
    { id: 'n5', position: { x: 760, y: 0 } },
    { id: 'missing', position: { x: 1, y: 1 } },
  ])).toEqual([
    { op: 'move', node: 'n1', x: 12, y: -8 },
    { op: 'move', node: 'n2', x: 380, y: 40 },
  ])
})

it('moves a group once when its members were dragged along with it', () => {
  expect(moveOperations(document, [
    { id: 'g4', position: { x: 400, y: 0 } },
    { id: 'n2', position: { x: 30, y: 70 } },
  ])).toEqual([{ op: 'move', node: 'g4', x: 400, y: 0 }])
})

it('dissolves a deleted group, removes deleted nodes, and disconnects deleted edges that would remain', () => {
  expect(deleteOperations(document, ['g4', 'n2', 'n3'], [])).toEqual([{ op: 'ungroup', node: 'g4' }])
  expect(deleteOperations(document, ['n2', 'missing'], ['n1->n2', 'g4->n5'])).toEqual([
    { op: 'remove', node: 'n2' },
    { op: 'disconnect', from: 'g4', to: 'n5' },
  ])
  expect(deleteOperations(document, [], [])).toEqual([])
})

it('offers only ungrouped content nodes to a new group', () => {
  expect(groupable(document, ['n1', 'n2', 'g4', 'n5'])).toEqual(['n1', 'n5'])
})
