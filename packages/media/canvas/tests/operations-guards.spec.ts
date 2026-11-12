import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { EMPTY_CANVAS } from '../src/document.ts'
import { applyOperations } from '../src/operations.ts'
import type { CanvasDocument, CanvasNode, CanvasOperation, NodeVersion, Shot } from '../src/types.ts'

const limits = resolveConfig({})
const now = (): string => '2026-01-01T00:00:00.000Z'

const run = (document: CanvasDocument, operations: readonly CanvasOperation[], config = limits) =>
  applyOperations(document, operations, { limits: config, now })

const node = (id: string, type: CanvasNode['type'], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id: id as CanvasNode['id'], type, title: id, x: 0, y: 0, width: 100, height: 100, ...extra,
})

const version = (id: string, extra: Partial<NodeVersion> = {}): NodeVersion => ({
  id: id as NodeVersion['id'], createdAt: now(), origin: 'user', ...extra,
})

const shot = (id: string): Shot => ({
  id: id as Shot['id'], title: id, shotSize: 'medium', visual: '', motion: '', camera: '', durationSec: 2,
  characters: [], props: [], dialogue: [], sfx: '', negative: '',
})

const documentOf = (nodes: readonly CanvasNode[], edges: CanvasDocument['edges'] = []): CanvasDocument => ({
  version: 2, revision: 0, nextId: nodes.length + 1, nodes, edges,
})

describe('operation guards', () => {
  it('detects cycles through a chain', () => {
    const base = run(EMPTY_CANVAS, [
      { op: 'add', type: 'text', text: 'a' },
      { op: 'add', type: 'text', text: 'b' },
      { op: 'add', type: 'text', text: 'c' },
      { op: 'connect', from: 'n1', to: 'n2' },
      { op: 'connect', from: 'n2', to: 'n3' },
    ]).document
    expect(run(base, [{ op: 'connect', from: 'n3', to: 'n1' }]).result.skipped)
      .toEqual([{ index: 0, op: 'connect', reason: 'connecting n3 to n1 would create a cycle' }])
  })

  it('keeps refs unique and groups typed', () => {
    const base = run(EMPTY_CANVAS, [{ op: 'add', type: 'text', text: 'a' }]).document
    expect(run(base, [{ op: 'add', ref: 'n1', type: 'text', text: 'b' }]).result.skipped)
      .toEqual([{ index: 0, op: 'add', reason: 'ref n1 is already in use' }])
    expect(run(base, [{ op: 'add', type: 'text', text: 'b', group: 'n1' }]).result.skipped)
      .toEqual([{ index: 0, op: 'add', reason: 'node n1 is not a group' }])
  })

  it('numbers a new version past the highest numeric id', () => {
    const base = documentOf([node('n1', 'text', { versions: [version('draft', { text: 'a' })], activeVersion: 'draft' as never })])
    const next = run(base, [{ op: 'set_text', node: 'n1', text: 'b' }])
    expect(next.document.nodes[0]?.activeVersion).toBe('v1')
  })

  it('starts a version list for a node that has none', () => {
    const base = documentOf([node('n1', 'text')])
    expect(run(base, [{ op: 'update', node: 'n1', text: 'body' }]).document.nodes[0]?.versions).toEqual([
      { id: 'v1', text: 'body', createdAt: now(), origin: 'user' },
    ])
  })

  it('evicts media versions by the media limit', () => {
    const base = documentOf([node('n1', 'image', {
      versions: ['v1', 'v2', 'v3'].map(id => version(id, { path: `/${id}.png` })),
      activeVersion: 'v3' as never,
    })])
    const next = run(base, [{ op: 'move', node: 'n1', x: 5, y: 5 }], resolveConfig({ versionLimit: 2 })).document
    expect(next.nodes[0]?.versions?.map(entry => entry.id)).toEqual(['v2', 'v3'])
  })

  it('rejects shot edits on a node that is not a storyboard', () => {
    const base = run(EMPTY_CANVAS, [{ op: 'add', type: 'text', text: 'a' }]).document
    expect(run(base, [{ op: 'update_shot', node: 'n1', shot: 's1', patch: {} }]).result.skipped)
      .toEqual([{ index: 0, op: 'update_shot', reason: 'node n1 is not a storyboard' }])
    expect(run(base, [{ op: 'insert_shot', node: 'n1', shot: shot('s1') }]).result.skipped)
      .toEqual([{ index: 0, op: 'insert_shot', reason: 'node n1 is not a storyboard' }])
    expect(run(base, [{ op: 'remove_shot', node: 'n1', shot: 's1' }]).result.skipped)
      .toEqual([{ index: 0, op: 'remove_shot', reason: 'node n1 is not a storyboard' }])
    expect(run(base, [{ op: 'move_shot', node: 'n1', shot: 's1' }]).result.skipped)
      .toEqual([{ index: 0, op: 'move_shot', reason: 'node n1 is not a storyboard' }])
  })

  it('rejects an unknown shot id', () => {
    const base = run(EMPTY_CANVAS, [{ op: 'add', type: 'storyboard', shots: [shot('s1')] }]).document
    expect(run(base, [{ op: 'update_shot', node: 'n1', shot: 's9', patch: {} }]).result.skipped)
      .toEqual([{ index: 0, op: 'update_shot', reason: 'shot s9 does not exist' }])
    expect(run(base, [{ op: 'move_shot', node: 'n1', shot: 's1', after: 's9' }]).result.skipped)
      .toEqual([{ index: 0, op: 'move_shot', reason: 'shot s9 does not exist' }])
  })

  it('creates storyboards and timelines with no content and names them after their type', () => {
    const { document } = run(EMPTY_CANVAS, [
      { op: 'add', type: 'storyboard' },
      { op: 'add', type: 'timeline' },
    ])
    expect(document.nodes.map(entry => entry.title)).toEqual(['storyboard', 'timeline'])
    expect(document.nodes[0]?.versions).toEqual([{ id: 'v1', createdAt: now(), origin: 'user' }])
  })

  it('rejects empty content and oversized prompts', () => {
    const small = resolveConfig({ maxPromptLength: 3 })
    expect(run(EMPTY_CANVAS, [{ op: 'add', type: 'text', text: '' }]).result.skipped)
      .toEqual([{ index: 0, op: 'add', reason: 'a text node needs text' }])
    expect(run(EMPTY_CANVAS, [{ op: 'add', type: 'image', path: '' }]).result.skipped)
      .toEqual([{ index: 0, op: 'add', reason: 'an image node needs path' }])
    expect(run(EMPTY_CANVAS, [{ op: 'add', type: 'audio', path: '' }]).result.skipped)
      .toEqual([{ index: 0, op: 'add', reason: 'an audio node needs path' }])
    expect(run(EMPTY_CANVAS, [{ op: 'add', type: 'image', path: '/a.png', gen: { kind: 'image', prompt: 'long', params: {} } }], small).result.skipped)
      .toEqual([{ index: 0, op: 'add', reason: 'prompt exceeds 3 characters' }])
  })

  it('rejects an added storyboard with too many shots', () => {
    expect(run(EMPTY_CANVAS, [{ op: 'add', type: 'storyboard', shots: [shot('s1'), shot('s2')] }], resolveConfig({ maxShotsPerStoryboard: 1 })).result.skipped)
      .toEqual([{ index: 0, op: 'add', reason: 'a storyboard holds at most 1 shots' }])
  })

  it('stores a group title and link refs on group creation', () => {
    const { document } = run(EMPTY_CANVAS, [
      { op: 'add', ref: 'a', type: 'text', text: 'a' },
      { op: 'group', nodes: ['a'] },
    ])
    expect(document.nodes[1]).toMatchObject({ type: 'group', title: 'Group' })
  })

  it('applies generation changes to an audio node with defaults', () => {
    const base = run(EMPTY_CANVAS, [{ op: 'add', type: 'audio', path: '/a.mp3' }]).document
    const { document } = run(base, [{ op: 'set_gen', node: 'n1', gen: {} }])
    expect(document.nodes[0]?.gen).toEqual({ kind: 'speech', prompt: '', params: {} })
    const kept = run(base, [{ op: 'set_gen', node: 'n1', gen: { kind: 'music', model: 'm', prompt: 'sing' } }]).document
    expect(kept.nodes[0]?.gen).toMatchObject({ kind: 'music', model: 'm', prompt: 'sing' })
  })

  it('rewrites one version for repeated text edits in a single call', () => {
    const base = run(EMPTY_CANVAS, [{ op: 'add', type: 'text', text: 'a' }]).document
    const { document } = run(base, [
      { op: 'set_text', node: 'n1', text: 'b' },
      { op: 'set_text', node: 'n1', text: 'c' },
    ])
    expect(document.nodes[0]?.versions).toHaveLength(2)
    expect(document.nodes[0]?.versions?.[1]?.text).toBe('c')
  })

  it('rejects a reference edge whose role cannot be inferred and role/kind conflicts', () => {
    const base = run(EMPTY_CANVAS, [
      { op: 'add', type: 'image', path: '/a.png' },
      { op: 'add', type: 'text', text: 'a' },
    ]).document
    expect(run(base, [{ op: 'connect', from: 'n1', to: 'n2', kind: 'reference' }]).result.skipped)
      .toEqual([{ index: 0, op: 'connect', reason: 'cannot infer what n1 supplies to n2' }])
    expect(run(base, [{ op: 'connect', from: 'n1', to: 'n2', kind: 'derivation', role: 'ref' }]).result.skipped)
      .toEqual([{ index: 0, op: 'connect', reason: 'a derivation edge carries no role' }])
    expect(run(base, [{ op: 'connect', from: 'n2', to: 'n1', role: 'first_frame' }]).result.skipped)
      .toEqual([{ index: 0, op: 'connect', reason: 'first_frame connects an image to a video' }])
    expect(run(base, [{ op: 'connect', from: 'n2', to: 'n1', role: 'last_frame' }]).result.skipped)
      .toEqual([{ index: 0, op: 'connect', reason: 'last_frame connects an image to a video' }])
  })

  it('rejects a group connected to its own member', () => {
    const base = run(EMPTY_CANVAS, [
      { op: 'add', type: 'text', text: 'a' },
      { op: 'group', nodes: ['n1'] },
    ]).document
    expect(run(base, [{ op: 'connect', from: 'g2', to: 'n1' }]).result.skipped)
      .toEqual([{ index: 0, op: 'connect', reason: 'a group cannot connect to its own member' }])
    expect(run(base, [{ op: 'connect', from: 'n1', to: 'g2' }]).result.skipped)
      .toEqual([{ index: 0, op: 'connect', reason: 'a group cannot connect to its own member' }])
  })

  it('skips reordering a source that has no reference edge', () => {
    const base = run(EMPTY_CANVAS, [
      { op: 'add', type: 'image', path: '/a.png' },
      { op: 'add', type: 'video', path: '/v.mp4' },
    ]).document
    expect(run(base, [{ op: 'reorder_refs', node: 'n2', sources: ['n1'] }]).result.skipped).toEqual([])
  })

  it('rejects an operation the closed union does not name', () => {
    expect(() => run(EMPTY_CANVAS, [{ op: 'bogus' } as unknown as CanvasOperation])).toThrow('unhandled operation')
  })

  it('refuses a result that exceeds the node or edge bound', () => {
    const tiny = resolveConfig({ maxNodes: 1 })
    expect(() => run(EMPTY_CANVAS, [
      { op: 'add', type: 'text', text: 'a' },
      { op: 'add', type: 'text', text: 'b' },
    ], tiny)).toThrow('nodes')
    const tinyEdges = resolveConfig({ maxEdges: 0 + 1 })
    expect(() => run(EMPTY_CANVAS, [
      { op: 'add', type: 'text', text: 'a' },
      { op: 'add', type: 'text', text: 'b' },
      { op: 'add', type: 'text', text: 'c' },
      { op: 'connect', from: 'n1', to: 'n2' },
      { op: 'connect', from: 'n2', to: 'n3' },
    ], tinyEdges)).toThrow('edges')
  })

  it('unversions a removed node and drops edges that touch it', () => {
    const base = run(EMPTY_CANVAS, [
      { op: 'add', type: 'text', text: 'a' },
      { op: 'add', type: 'text', text: 'b' },
      { op: 'connect', from: 'n1', to: 'n2' },
    ]).document
    const { document } = run(base, [{ op: 'remove', node: 'n1' }])
    expect(document.nodes.map(entry => entry.id)).toEqual(['n2'])
    expect(document.edges).toEqual([])
  })
})

describe('remaining operation paths', () => {
  const base = (...ops: CanvasOperation[]) => run(EMPTY_CANVAS, ops).document

  it('walks a diamond in the cycle check', () => {
    const document = base(
      { op: 'add', type: 'text', text: 'a' },
      { op: 'add', type: 'text', text: 'b' },
      { op: 'add', type: 'text', text: 'c' },
      { op: 'add', type: 'text', text: 'd' },
      { op: 'connect', from: 'n1', to: 'n2' },
      { op: 'connect', from: 'n1', to: 'n3' },
      { op: 'connect', from: 'n2', to: 'n4' },
      { op: 'connect', from: 'n3', to: 'n4' },
    )
    expect(run(document, [{ op: 'connect', from: 'n4', to: 'n1' }]).result.skipped)
      .toEqual([{ index: 0, op: 'connect', reason: 'connecting n4 to n1 would create a cycle' }])
  })

  it('keeps unrelated edges when removing a node', () => {
    const document = base(
      { op: 'add', type: 'text', text: 'a' },
      { op: 'add', type: 'text', text: 'b' },
      { op: 'add', type: 'text', text: 'c' },
      { op: 'connect', from: 'n1', to: 'n2' },
      { op: 'connect', from: 'n3', to: 'n2' },
    )
    const removed = run(document, [{ op: 'remove', node: 'n1' }]).document
    expect(removed.edges.map(edge => edge.id)).toEqual(['n3->n2'])
  })

  it('reads an empty shot list from a storyboard without a version', () => {
    const document = documentOf([node('n1', 'storyboard')])
    expect(run(document, [{ op: 'update_shot', node: 'n1', shot: 's1', patch: {} }]).result.skipped)
      .toEqual([{ index: 0, op: 'update_shot', reason: 'shot s1 does not exist' }])
  })

  it('orders a new reference after an edge that carries no order', () => {
    const document = documentOf(
      [node('n1', 'image'), node('n2', 'image'), node('n3', 'video')],
      [{ id: 'n1->n3:ref', source: 'n1' as never, target: 'n3' as never, kind: 'reference', role: 'ref' }],
    )
    const next = run(document, [{ op: 'connect', from: 'n2', to: 'n3', role: 'ref' }]).document
    expect(next.edges.map(edge => [edge.id, edge.order])).toEqual([['n1->n3:ref', undefined], ['n2->n3:ref', 1]])
  })

  it('names a missing video file and a missing text body', () => {
    expect(run(EMPTY_CANVAS, [{ op: 'add', type: 'video', path: '' }]).result.skipped)
      .toEqual([{ index: 0, op: 'add', reason: 'a video node needs path' }])
    expect(run(EMPTY_CANVAS, [{ op: 'add', type: 'script' }]).result.skipped)
      .toEqual([{ index: 0, op: 'add', reason: 'a script node needs text' }])
  })

  it('rejects text edits on plain media and text on a non-text node', () => {
    const document = base({ op: 'add', type: 'image', path: '/a.png' })
    expect(run(document, [{ op: 'update', node: 'n1', text: 'x' }]).result.skipped)
      .toEqual([{ index: 0, op: 'update', reason: 'node n1 is not a text node' }])
    expect(run(document, [{ op: 'set_text', node: 'n1', text: 'x' }]).result.skipped)
      .toEqual([{ index: 0, op: 'set_text', reason: 'node n1 is not a text node' }])
  })

  it('rejects a generation prompt above the bound and defaults the kind of media nodes', () => {
    const document = base({ op: 'add', type: 'video', path: '/v.mp4' })
    expect(run(document, [{ op: 'set_gen', node: 'n1', gen: { prompt: 'long prompt' } }], resolveConfig({ maxPromptLength: 3 })).result.skipped)
      .toEqual([{ index: 0, op: 'set_gen', reason: 'prompt exceeds 3 characters' }])
    expect(run(document, [{ op: 'set_gen', node: 'n1', gen: {} }]).document.nodes[0]?.gen)
      .toEqual({ kind: 'video', prompt: '', params: {} })
  })

  it('skips a version switch on a node with no versions', () => {
    expect(run(documentOf([node('n1', 'text')]), [{ op: 'set_version', node: 'n1', version: 'v1' }]).result.skipped)
      .toEqual([{ index: 0, op: 'set_version', reason: 'node n1 has no version v1' }])
  })

  it('rejects a disconnect of a role no edge supplies', () => {
    const document = base({ op: 'add', type: 'image', path: '/a.png' }, { op: 'add', type: 'video', path: '/v.mp4' })
    expect(run(document, [{ op: 'disconnect', from: 'n1', to: 'n2', role: 'ref' }]).result.skipped)
      .toEqual([{ index: 0, op: 'disconnect', reason: 'n1 does not supply ref to n2' }])
  })

  it('rejects nested groups and empty resize sizes', () => {
    const document = base({ op: 'add', type: 'text', text: 'a' }, { op: 'group', nodes: ['n1'] })
    expect(run(document, [{ op: 'group', nodes: ['g2'] }]).result.skipped)
      .toEqual([{ index: 0, op: 'group', reason: 'node g2 is a group; groups do not nest' }])
    expect(run(document, [{ op: 'resize', node: 'n1', width: 0, height: 10 }]).result.skipped)
      .toEqual([{ index: 0, op: 'resize', reason: 'width and height must be positive' }])
  })

  it('numbers an inserted shot past a non-numeric id', () => {
    const document = base({ op: 'add', type: 'storyboard', shots: [{ ...shot('draft'), id: 'draft' as never }] })
    const next = run(document, [{ op: 'insert_shot', node: 'n1', shot: shot('next') }]).document
    expect(next.nodes[0]?.versions?.[1]?.shots?.map(entry => entry.id)).toEqual(['draft', 's1'])
  })
})

describe('search and lookup paths', () => {
  it('walks a node twice before concluding there is no cycle', () => {
    const document = run(EMPTY_CANVAS, [
      { op: 'add', type: 'text', text: 'a' },
      { op: 'add', type: 'text', text: 'b' },
      { op: 'add', type: 'text', text: 'c' },
      { op: 'add', type: 'text', text: 'd' },
      { op: 'connect', from: 'n1', to: 'n2' },
      { op: 'connect', from: 'n1', to: 'n3' },
      { op: 'connect', from: 'n2', to: 'n3' },
    ]).document
    const { document: next, result } = run(document, [{ op: 'connect', from: 'n4', to: 'n1' }])
    expect(result.skipped).toEqual([])
    expect(next.edges.map(edge => edge.id)).toContain('n4->n1')
  })

  it('rejects moving an unknown shot', () => {
    const document = run(EMPTY_CANVAS, [{ op: 'add', type: 'storyboard', shots: [shot('s1')] }]).document
    expect(run(document, [{ op: 'move_shot', node: 'n1', shot: 's9' }]).result.skipped)
      .toEqual([{ index: 0, op: 'move_shot', reason: 'shot s9 does not exist' }])
  })
})

describe('host-side version and status operations', () => {
  it('appends a version a generation produced', () => {
    const base = run(EMPTY_CANVAS, [{ op: 'add', type: 'image', path: '/a.png' }]).document
    const { document } = run(base, [{
      op: 'append_version',
      node: 'n1',
      version: { path: '/a-v2.png', prompt: 'again', model: 'm', durationMs: 1000, origin: 'agent' },
    }])
    expect(document.nodes[0]?.versions?.map(version => [version.id, version.path, version.origin])).toEqual([
      ['v1', '/a.png', 'user'],
      ['v2', '/a-v2.png', 'agent'],
    ])
    expect(document.nodes[0]?.activeVersion).toBe('v2')
  })

  it('accepts an explicit version id and the call clock, and rejects a group', () => {
    const base = run(EMPTY_CANVAS, [{ op: 'add', type: 'image', path: '/a.png' }, { op: 'group', nodes: ['n1'] }]).document
    const { document } = run(base, [{
      op: 'append_version', node: 'n1', version: { id: 'v9', path: '/b.png', createdAt: 'then', origin: 'user' },
    }])
    expect(document.nodes[0]?.versions?.[1]).toMatchObject({ id: 'v9', createdAt: 'then', origin: 'user' })
    expect(run(base, [{ op: 'append_version', node: 'g2', version: { path: '/b.png', createdAt: 'now', origin: 'user' } }]).result.skipped)
      .toEqual([{ index: 0, op: 'append_version', reason: 'node g2 is a group' }])
  })

  it('mirrors and clears a generation status', () => {
    const base = run(EMPTY_CANVAS, [{ op: 'add', type: 'image', path: '/a.png' }]).document
    const running = run(base, [{
      op: 'set_status', node: 'n1', status: { state: 'running', jobId: 'media-1' as never, at: 'now', progress: 0.4 },
    }]).document
    expect(running.nodes[0]?.status).toEqual({ state: 'running', jobId: 'media-1', at: 'now', progress: 0.4 })
    const cleared = run(running, [{ op: 'set_status', node: 'n1', status: null }]).document
    expect(cleared.nodes[0]?.status).toBeUndefined()
  })
})

describe('host-side stale and tail operations', () => {
  it('marks and clears a stale node', () => {
    const base = run(EMPTY_CANVAS, [{ op: 'add', type: 'video', path: '/a.mp4' }]).document
    const stale = run(base, [{ op: 'set_stale', node: 'n1', stale: true }]).document
    expect(stale.nodes[0]?.stale).toBe(true)
    expect(run(stale, [{ op: 'set_stale', node: 'n1', stale: false }]).document.nodes[0]?.stale).toBeUndefined()
  })

  it('records and clears the tail frame of a video node', () => {
    const base = run(EMPTY_CANVAS, [
      { op: 'add', type: 'video', path: '/a.mp4' },
      { op: 'add', type: 'image', path: '/tail.png' },
    ]).document
    const withTail = run(base, [{
      op: 'set_tail', node: 'n1', tailOf: { node: 'n2' as never, version: 'v1' as never },
    }]).document
    expect(withTail.nodes[0]?.tailOf).toEqual({ node: 'n2', version: 'v1' })
    expect(run(withTail, [{ op: 'set_tail', node: 'n1', tailOf: null }]).document.nodes[0]?.tailOf).toBeUndefined()
  })
})
