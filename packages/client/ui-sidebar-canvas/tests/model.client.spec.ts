import { describe, expect, it } from 'vitest'
import type { CanvasDocument, CanvasNode, Shot } from '@deepseek-ai/dsh-canvas/client'
import { EditHistory, invertOperations } from '../src/client/model/history.ts'
import { automaticRole, edgeLabel, edgeStyle, roleMenu } from '../src/client/model/edges.ts'
import { inspectorPlacement } from '../src/client/model/inspector.ts'
import { appendShotOperation, cellOperation, moveShotOperation, removeShotOperation, rowsOf, segmentOfShot, summaryOf } from '../src/client/model/table.ts'

const shot = (id: string, overrides: Partial<Shot> = {}): Shot => ({
  id: id as never, title: id, shotSize: 'medium', visual: `画面 ${id}`, motion: '动作', camera: '固定', durationSec: 3,
  characters: [], props: [], dialogue: [], sfx: '', negative: '', ...overrides,
})

const node = (id: string, type: CanvasNode['type'], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id: id as never, type, title: id, x: 10, y: 20, width: 100, height: 80, ...extra,
})

const document = (nodes: readonly CanvasNode[], edges: CanvasDocument['edges'] = []): CanvasDocument => ({
  version: 2, revision: 1, nextId: nodes.length + 1, nodes, edges,
})

describe('invertOperations', () => {
  it('reverses moves, version changes, edits, and connects', () => {
    const board = node('n1', 'storyboard', {
      versions: [{ id: 'v2' as never, createdAt: 'now', origin: 'user', shots: [shot('s1')] }],
      activeVersion: 'v2' as never,
      gen: { kind: 'video', prompt: 'p', params: {} },
    })
    const image = node('n2', 'image')
    const before = document([board, image], [
      { id: 'n2->n1:ref', source: 'n2' as never, target: 'n1' as never, kind: 'reference', role: 'ref', order: 0 },
    ])
    const inverse = invertOperations(before, [
      { op: 'move', node: 'n1', x: 99, y: 100 },
      { op: 'set_version', node: 'n1', version: 'v1' },
      { op: 'set_shots', node: 'n1', shots: [shot('s9')] },
      { op: 'connect', from: 'n2', to: 'n1', kind: 'reference', role: 'first_frame' },
    ])
    expect(inverse).toEqual([
      { op: 'disconnect', from: 'n2', to: 'n1', role: 'first_frame' },
      { op: 'set_shots', node: 'n1', shots: [shot('s1')] },
      { op: 'set_version', node: 'n1', version: 'v2' },
      { op: 'move', node: 'n1', x: 10, y: 20 },
    ])
  })

  it('returns undefined for edits it cannot reverse', () => {
    expect(invertOperations(document([]), [{ op: 'remove', node: 'n1' }])).toBeUndefined()
    expect(invertOperations(document([]), [{ op: 'add', type: 'text', text: 'x' }])).toBeUndefined()
  })

  it('restores an insert by removing the shot, and a removal by inserting it back', () => {
    const board = node('n1', 'storyboard', {
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1'), shot('s2')] }],
      activeVersion: 'v1' as never,
    })
    const doc = document([board])
    expect(invertOperations(doc, [{ op: 'remove_shot', node: 'n1', shot: 's2' as never }])).toEqual([
      { op: 'insert_shot', node: 'n1', after: 's1', shot: { title: 's2', shotSize: 'medium', visual: '画面 s2', motion: '动作', camera: '固定', durationSec: 3, characters: [], props: [], dialogue: [], sfx: '', negative: '' } },
    ])
    expect(invertOperations(doc, [{ op: 'move_shot', node: 'n1', shot: 's2' as never }])).toEqual([
      { op: 'move_shot', node: 'n1', shot: 's2', after: 's1' },
    ])
  })

  it('restores a removed reference order', () => {
    const video = node('n9', 'video')
    const doc = document([video], [
      { id: 'a->n9:ref', source: 'a' as never, target: 'n9' as never, kind: 'reference', role: 'ref', order: 1 },
      { id: 'b->n9:ref', source: 'b' as never, target: 'n9' as never, kind: 'reference', role: 'ref', order: 0 },
    ])
    expect(invertOperations(doc, [{ op: 'reorder_refs', node: 'n9', sources: ['a', 'b'] }])).toEqual([
      { op: 'reorder_refs', node: 'n9', sources: ['b', 'a'] },
    ])
  })
})

describe('EditHistory', () => {
  const board = node('n1', 'storyboard', {
    versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1')] }],
    activeVersion: 'v1' as never,
  })
  const doc = document([board])

  it('undoes and redoes the newest reversible edit', () => {
    const history = new EditHistory()
    expect(history.record(doc, [{ op: 'move', node: 'n1', x: 1, y: 1 }], '移动')).toBe(true)
    expect(history.canUndo()).toBe(true)
    expect(history.undoLabel()).toBe('移动')
    expect(history.undo()).toEqual([{ op: 'move', node: 'n1', x: 10, y: 20 }])
    expect(history.canRedo()).toBe(true)
    expect(history.redo()).toEqual([{ op: 'move', node: 'n1', x: 1, y: 1 }])
  })

  it('clears the history when an edit cannot be reversed', () => {
    const history = new EditHistory()
    history.record(doc, [{ op: 'move', node: 'n1', x: 1, y: 1 }], '移动')
    expect(history.record(doc, [{ op: 'remove', node: 'n1' }], '删除')).toBe(false)
    expect(history.canUndo()).toBe(false)
    history.clear()
    expect(history.canRedo()).toBe(false)
  })

  it('ignores an empty edit', () => {
    expect(new EditHistory().record(doc, [], '无')).toBe(false)
  })
})

describe('edge roles', () => {
  it('offers the roles two kinds may carry and marks the ones already present', () => {
    expect(roleMenu('image', 'video', ['ref'])).toEqual([
      { role: 'ref', labelKey: 'edge.ref', taken: true },
      { role: 'first_frame', labelKey: 'edge.firstFrame', taken: false },
      { role: 'last_frame', labelKey: 'edge.lastFrame', taken: false },
    ])
    expect(roleMenu('image', 'audio', [])).toEqual([])
  })

  it('picks the only open role automatically', () => {
    expect(automaticRole(roleMenu('image', 'video', ['ref', 'first_frame']))).toBe('last_frame')
    expect(automaticRole(roleMenu('image', 'video', []))).toBeUndefined()
    expect(automaticRole(roleMenu('image', 'image', []))).toBe('ref')
  })

  it('styles and labels each role', () => {
    expect(edgeStyle(undefined).strokeDasharray).toBeUndefined()
    expect(edgeStyle('prompt').strokeDasharray).toBe('6 4')
    expect(edgeStyle('ref').stroke).toContain('accent')
    expect(edgeLabel(undefined, undefined)).toBeUndefined()
    expect(edgeLabel('ref', 0)).toEqual({ key: 'edge.ref', n: 1 })
    expect(edgeLabel('prompt', 2)).toEqual({ key: 'edge.prompt', n: 3 })
  })
})

describe('inspector placement', () => {
  it('keeps a sidebar only when the studio is wide enough', () => {
    expect(inspectorPlacement(960)).toBe('sidebar')
    expect(inspectorPlacement(959)).toBe('drawer')
    expect(inspectorPlacement(1200, 1000)).toBe('sidebar')
  })
})

describe('storyboard table', () => {
  const board = node('n1', 'storyboard', {
    versions: [{
      id: 'v1' as never, createdAt: 'now', origin: 'user',
      shots: [shot('s1'), shot('s2', { durationSec: 4, shotSize: 'close' }), shot('s3')],
    }],
    activeVersion: 'v1' as never,
  })

  it('reads the current rows and summarises the segmentation', () => {
    expect(rowsOf(board).map(row => row.id)).toEqual(['s1', 's2', 's3'])
    const summary = summaryOf(board)
    expect(summary.shots).toBe(3)
    expect(summary.seconds).toBe(10)
    expect(summary.videoCalls).toBeGreaterThan(0)
    expect(segmentOfShot(summary.segments, 's1' as never)).toBe(0)
  })

  it('turns a cell edit into a shot update, raising a short duration to one second', () => {
    expect(cellOperation(board, 's2' as never, 'shotSize', 'wide')).toEqual({
      op: 'update_shot', node: 'n1', shot: 's2', patch: { shotSize: 'wide' },
    })
    expect(cellOperation(board, 's2' as never, 'durationSec', 0.2)).toEqual({
      op: 'update_shot', node: 'n1', shot: 's2', patch: { durationSec: 1 },
    })
    expect(cellOperation(board, 's2' as never, 'characters', ['c1'])).toMatchObject({ patch: { characters: ['c1'] } })
    expect(cellOperation(board, 's2' as never, 'visual', '新画面')).toMatchObject({ patch: { visual: '新画面' } })
  })

  it('appends, removes, and moves shots', () => {
    expect(appendShotOperation(board, shot('s4', { title: 's4' }))).toMatchObject({ op: 'insert_shot', after: 's3' })
    expect(removeShotOperation(board, 's2' as never)).toEqual({ op: 'remove_shot', node: 'n1', shot: 's2' })
    expect(moveShotOperation(board, 's3' as never, 's1' as never)).toEqual({ op: 'move_shot', node: 'n1', shot: 's3', after: 's1' })
    expect(moveShotOperation(board, 's3' as never, undefined)).toEqual({ op: 'move_shot', node: 'n1', shot: 's3' })
  })
})
