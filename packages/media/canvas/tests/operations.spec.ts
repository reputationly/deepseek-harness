import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { EMPTY_CANVAS } from '../src/document.ts'
import { applyOperations, CanvasConflictError, checkRevision } from '../src/operations.ts'
import type { CanvasDocument, CanvasOperation, Shot } from '../src/types.ts'

const limits = resolveConfig({})
const now = (): string => '2026-01-01T00:00:00.000Z'

function build(operations: readonly CanvasOperation[], from: CanvasDocument = EMPTY_CANVAS, rejected?: ReadonlyMap<number, string>) {
  return applyOperations(from, operations, { limits, now, ...rejected === undefined ? {} : { rejected } })
}

function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

const shot = (id: string, overrides: Partial<Shot> = {}): Shot => ({
  id: id as Shot['id'],
  title: id,
  shotSize: 'medium',
  visual: 'a street',
  motion: 'walking',
  camera: 'static',
  durationSec: 3,
  characters: [],
  props: [],
  dialogue: [],
  sfx: '',
  negative: '',
  ...overrides,
})

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
    expect(result).toEqual({
      revision: 1,
      refs: { brief: 'n1', a: 'n2', b: 'n3', options: 'g4' },
      created: ['n1', 'n2', 'n3', 'g4'],
      skipped: [],
    })
    expect(document.nextId).toBe(5)
    expect(document.revision).toBe(1)
    // text-to-text edges carry no input meaning, so they are derivation edges.
    expect(document.edges).toEqual([
      { id: 'n1->n2', source: 'n1', target: 'n2', kind: 'derivation' },
      { id: 'n1->n3', source: 'n1', target: 'n3', kind: 'derivation' },
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

  it('stores the first version of a node instead of top-level content', () => {
    const { document } = build([
      { op: 'add', type: 'image', path: '/a.png', bible: 'c1' as never },
      { op: 'add', type: 'script', text: '【场1】雨夜' },
      { op: 'add', type: 'storyboard', shots: [shot('s1')] },
    ])
    const [image, script, storyboard] = document.nodes
    expect(image).toMatchObject({ type: 'image', title: 'a.png', activeVersion: 'v1', bible: 'c1' })
    expect(image?.versions).toEqual([{ id: 'v1', path: '/a.png', createdAt: now(), origin: 'user' }])
    expect(script?.versions?.[0]).toMatchObject({ text: '【场1】雨夜' })
    expect(storyboard?.versions?.[0]?.shots).toHaveLength(1)
  })

  it('infers the role from the node kinds and keeps role ids apart', () => {
    const { document, result } = build([
      { op: 'add', ref: 'text', type: 'text', text: 'prompt' },
      { op: 'add', ref: 'ref', type: 'image', path: '/ref.png' },
      { op: 'add', ref: 'video', type: 'video', path: '/v.mp4' },
      { op: 'connect', from: 'text', to: 'video' },
      { op: 'connect', from: 'ref', to: 'video' },
      { op: 'connect', from: 'ref', to: 'video', role: 'first_frame' },
      { op: 'connect', from: 'ref', to: 'video', role: 'ref' },
    ])
    expect(result.skipped).toEqual([{ index: 6, op: 'connect', reason: 'n2 already supplies ref to n3' }])
    // The same image can be both a reference and the first frame of one video.
    expect(document.edges.map(edge => edge.id)).toEqual(['n1->n3:prompt', 'n2->n3:ref', 'n2->n3:first_frame'])
    expect(document.edges.find(edge => edge.role === 'ref')?.order).toBe(0)
  })

  it('takes one first frame and one last frame per video', () => {
    const { result } = build([
      { op: 'add', type: 'image', path: '/a.png' },
      { op: 'add', type: 'image', path: '/b.png' },
      { op: 'add', type: 'video', path: '/v.mp4' },
      { op: 'connect', from: 'n1', to: 'n3', role: 'first_frame' },
      { op: 'connect', from: 'n2', to: 'n3', role: 'first_frame' },
      { op: 'connect', from: 'n1', to: 'n3', role: 'last_frame' },
      { op: 'connect', from: 'n1', to: 'n2', role: 'first_frame' },
    ])
    expect(result.skipped.map(skip => skip.reason)).toEqual([
      'n3 already has a first_frame',
      'first_frame connects an image to a video',
    ])
  })

  it('rewrites the reference order', () => {
    const { document } = build([
      { op: 'add', type: 'image', path: '/a.png' },
      { op: 'add', type: 'image', path: '/b.png' },
      { op: 'add', type: 'video', path: '/v.mp4' },
      { op: 'connect', from: 'n1', to: 'n3', role: 'ref' },
      { op: 'connect', from: 'n2', to: 'n3', role: 'ref' },
      { op: 'reorder_refs', node: 'n3', sources: ['n2', 'n1'] },
    ])
    expect(document.edges.map(edge => [edge.id, edge.order])).toEqual([['n1->n3:ref', 1], ['n2->n3:ref', 0]])
  })

  it('disconnects one role or every edge between two nodes', () => {
    const base = build([
      { op: 'add', type: 'image', path: '/a.png' },
      { op: 'add', type: 'video', path: '/v.mp4' },
      { op: 'connect', from: 'n1', to: 'n2', role: 'ref' },
      { op: 'connect', from: 'n1', to: 'n2', role: 'first_frame' },
    ]).document
    expect(build([{ op: 'disconnect', from: 'n1', to: 'n2', role: 'ref' }], base).document.edges.map(edge => edge.id))
      .toEqual(['n1->n2:first_frame'])
    expect(build([{ op: 'disconnect', from: 'n1', to: 'n2' }], base).document.edges).toEqual([])
    expect(build([{ op: 'disconnect', from: 'n1', to: 'n2' }], base).result.skipped).toEqual([])
    expect(build([{ op: 'disconnect', from: 'n1', to: 'n2' }], EMPTY_CANVAS).result.skipped)
      .toEqual([{ index: 0, op: 'disconnect', reason: 'node n1 does not exist' }])
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
      [9, 'disconnect', 'n2 is not connected to n1'],
    ])
    expect(document.nodes.find(node => node.id === 'n2')?.title).toBe('Second')
    expect(document.nodes).toHaveLength(2)
  })

  it('reports no change when every operation is skipped or refused', () => {
    const { changed, result } = build(
      [{ op: 'remove', node: 'n1' }, { op: 'add', type: 'image', path: '/x.png' }],
      EMPTY_CANVAS,
      new Map([[1, 'file /x.png does not exist']]),
    )
    expect(changed).toBe(false)
    expect(result.revision).toBe(0)
    expect(result.skipped).toEqual([
      { index: 0, op: 'remove', reason: 'node n1 does not exist' },
      { index: 1, op: 'add', reason: 'file /x.png does not exist' },
    ])
  })

  it('sets generation parameters and removes the ones a caller clears', () => {
    const base = build([{
      op: 'add', type: 'video', path: '/v.mp4',
      gen: { kind: 'video', prompt: 'rain', model: 'm1', params: { ratio: '16:9', duration: 5 } },
    }]).document
    const { document } = build([
      { op: 'set_gen', node: 'n1', gen: { params: { duration: null, quality: 'high' }, model: 'm2' } },
    ], base)
    expect(document.nodes[0]?.gen).toEqual({
      kind: 'video',
      prompt: 'rain',
      model: 'm2',
      params: { ratio: '16:9', quality: 'high' },
    })
  })

  it('rejects generation parameters on a node that generates nothing', () => {
    const base = build([{ op: 'add', type: 'text', text: 'one' }]).document
    expect(build([{ op: 'set_gen', node: 'n1', gen: { prompt: 'x' } }], base).result.skipped)
      .toEqual([{ index: 0, op: 'set_gen', reason: 'node n1 does not generate media' }])
  })

  it('stores one new version per call for a storyboard rewrite', () => {
    const base = build([{ op: 'add', type: 'storyboard', shots: [shot('s1'), shot('s2')] }]).document
    const { document } = build([
      { op: 'update_shot', node: 'n1', shot: 's1', patch: { shotSize: 'close', durationSec: 4 } },
      { op: 'insert_shot', node: 'n1', after: 's1', shot: { ...shot('s9'), title: 'between' } },
      { op: 'move_shot', node: 'n1', shot: 's2', after: 's1' },
      { op: 'remove_shot', node: 'n1', shot: 's3' },
    ], base)
    const versions = document.nodes[0]?.versions ?? []
    expect(versions).toHaveLength(2)
    expect(versions[1]?.shots?.map(entry => entry.id)).toEqual(['s1', 's2'])
    expect(versions[1]?.shots?.[0]).toMatchObject({ shotSize: 'close', durationSec: 4 })
  })

  it('appends and replaces shots with stable ids', () => {
    const base = build([{ op: 'add', type: 'storyboard', shots: [shot('s4')] }]).document
    const inserted = build([{ op: 'insert_shot', node: 'n1', shot: shot('ignored') }], base).document
    expect(inserted.nodes[0]?.versions?.[1]?.shots?.map(entry => entry.id)).toEqual(['s4', 's5'])
    const replaced = build([{ op: 'set_shots', node: 'n1', shots: [shot('s7')] }], base).document
    expect(replaced.nodes[0]?.versions?.[1]?.shots?.map(entry => entry.id)).toEqual(['s7'])
  })

  it('refuses a storyboard longer than the deployment allows', () => {
    const small = applyOperations(EMPTY_CANVAS, [{ op: 'add', type: 'storyboard' }, {
      op: 'set_shots',
      node: 'n1',
      shots: Array.from({ length: 3 }, (_entry, index) => shot(`s${String(index + 1)}`)),
    }], { limits: resolveConfig({ maxShotsPerStoryboard: 2 }), now })
    expect(small.result.skipped).toEqual([{ index: 1, op: 'set_shots', reason: 'a storyboard holds at most 2 shots' }])
  })

  it('switches the active version and keeps the versions within the limit', () => {
    const narrow = resolveConfig({ textVersionLimit: 2 })
    let document = EMPTY_CANVAS
    for (const text of ['one', 'two', 'three']) {
      document = applyOperations(document, [
        text === 'one' ? { op: 'add', type: 'text', text } : { op: 'set_text', node: 'n1', text },
      ], { limits: narrow, now }).document
    }
    expect(document.nodes[0]?.versions).toHaveLength(2)
    expect(document.nodes[0]?.activeVersion).toBe('v3')
    document = applyOperations(document, [{ op: 'set_version', node: 'n1', version: 'v2' }], { limits: narrow, now }).document
    expect(document.nodes[0]?.activeVersion).toBe('v2')
    expect(applyOperations(document, [{ op: 'set_version', node: 'n1', version: 'v9' }], { limits: narrow, now }).result.skipped)
      .toEqual([{ index: 0, op: 'set_version', reason: 'node n1 has no version v9' }])
  })

  it('keeps an active version that the newest-versions rule would evict', () => {
    const narrow = resolveConfig({ textVersionLimit: 2 })
    const versions = [1, 2, 3, 4].map(at => ({ id: `v${String(at)}` as never, text: `body ${String(at)}`, createdAt: now(), origin: 'user' as const }))
    const base: CanvasDocument = {
      ...EMPTY_CANVAS,
      nodes: [{
        id: 'n1' as never, type: 'text', title: 'script', x: 0, y: 0, width: 100, height: 100,
        versions, activeVersion: 'v1' as never,
      }],
    }
    // The newest-versions rule would keep v3 and v4; v1 survives because it is active.
    const rewritten = applyOperations(base, [{ op: 'move', node: 'n1', x: 10, y: 10 }], { limits: narrow, now }).document
    expect(rewritten.nodes[0]?.versions?.map(version => version.id)).toEqual(['v1', 'v4'])
    const keptActive = applyOperations(
      { ...base, nodes: [{ ...base.nodes[0]!, versions: versions.slice(0, 4), activeVersion: 'v1' as never }] },
      [{ op: 'set_text', node: 'n1', text: 'body 5' }],
      { limits: narrow, now },
    ).document
    expect(keptActive.nodes[0]?.versions?.map(version => version.id)).toEqual(['v4', 'v5'])
    expect(keptActive.nodes[0]?.activeVersion).toBe('v5')
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
      { op: 'add', ref: 'out', type: 'image', path: '/out.png', gen: { kind: 'image', prompt: 'merge', model: 'm', params: {} } },
      { op: 'connect', from: 'g3', to: 'out', kind: 'derivation' },
    ], moved)
    const before = new Map(moved.nodes.filter(node => node.type !== 'group').map(node => [node.id, node]))
    for (const node of document.nodes) if (before.has(node.id)) expect(node).toEqual(before.get(node.id))
    const group = document.nodes.find(node => node.id === 'g3')
    const out = document.nodes.find(node => node.id === result.refs.out)
    expect(out).toMatchObject({ type: 'image', title: 'out.png' })
    expect(out?.versions?.[0]).toMatchObject({ path: '/out.png', prompt: 'merge', model: 'm' })
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
    const { document, result } = build([
      { op: 'resize', node: 'g3', width: 1, height: 1 },
      { op: 'resize', node: 'n1', width: 400, height: 300 },
      { op: 'ungroup', node: 'g3' },
    ], moved)
    expect(result.skipped).toEqual([{ index: 0, op: 'resize', reason: 'a group frame follows its members' }])
    expect(document.nodes.map(node => [node.id, node.group, node.width])).toEqual([['n1', undefined, 400], ['n2', undefined, 280]])
  })
})

describe('checkRevision', () => {
  it('accepts the current revision and rejects a stale one', () => {
    expect(() => checkRevision({ ...EMPTY_CANVAS, revision: 4 }, 4)).not.toThrow()
    expect(() => checkRevision({ ...EMPTY_CANVAS, revision: 4 }, undefined)).not.toThrow()
    expect(() => checkRevision({ ...EMPTY_CANVAS, revision: 4 }, 3)).toThrow(CanvasConflictError)
  })
})
