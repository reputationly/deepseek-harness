import { describe, expect, it } from 'vitest'
import type { CanvasDocument, CanvasNode, CanvasNodeId, Shot } from '@deepseek-ai/dsh-canvas/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { EditHistory, invertOperations } from '../src/client/model/history.ts'
import { automaticRole, edgeLabel, edgeStyle, roleMenu } from '../src/client/model/edges.ts'
import { inspectorPlacement } from '../src/client/model/inspector.ts'
import { cardState, currentVersion, durationSeconds, groupScene, scriptPreview, scriptScenes, shotBadge, storyboardCardView, versionChoices } from '../src/client/model/cards.ts'
import { frameOf, genOperation, modelChoices, operationFor, orderedRefs, paramControls, reorderOperation } from '../src/client/model/inspector.ts'
import { movedForward, newNodeIds } from '../src/client/model/changes.ts'
import { planShotSegments } from '@deepseek-ai/dsh-canvas/client'
import { applyOperations as applyCanvasOperations } from '../../../media/canvas/src/operations.ts'
import { resolveConfig } from '../../../media/canvas/src/config.ts'
import {
  appendShotOperation, blankShot, cellOperation, moveShotOperations, removeShotOperation, rowsOf, segmentOfShot, segmentTone, summaryOf,
} from '../src/client/model/table.ts'

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

  it('undoes an added node and a new group with Host operation semantics', () => {
    const limits = resolveConfig({})
    const before = document([node('n1', 'text'), node('n2', 'image')])

    const add = { op: 'add', type: 'text', text: 'new' } as const
    const addedResult = applyCanvasOperations(before, [add], { limits, now: () => 'now' })
    const added = addedResult.document
    const addInverse = invertOperations(before, [add], addedResult.result)
    expect(addInverse).toEqual([{ op: 'remove', node: 'n3' }])
    const addRestored = applyCanvasOperations(added, addInverse ?? [], { limits, now: () => 'now' }).document
    expect(addRestored.nodes.map(current => current.id)).toEqual(['n1', 'n2'])

    const group = { op: 'group', title: 'Group', nodes: ['n1', 'n2'] } as const
    const groupResult = applyCanvasOperations(before, [group], { limits, now: () => 'now' })
    const grouped = groupResult.document
    const groupInverse = invertOperations(before, [group], groupResult.result)
    expect(groupInverse).toEqual([{ op: 'ungroup', node: 'g3' }])
    const groupRestored = applyCanvasOperations(grouped, groupInverse ?? [], { limits, now: () => 'now' }).document
    expect(groupRestored.nodes.filter(current => current.type === 'group')).toEqual([])
    expect(groupRestored.nodes.map(current => [current.id, current.group])).toEqual([
      ['n1', undefined], ['n2', undefined],
    ])
  })

  it('rebuilds create inverses with Host ids after undoing and redoing nodes and groups', () => {
    const limits = resolveConfig({})
    const before = document([node('n1', 'text'), node('n2', 'image')])
    const history = new EditHistory()
    const add = { op: 'add', type: 'text', text: 'new' } as const
    const added = applyCanvasOperations(before, [add], { limits, now: () => 'now' })
    expect(history.record(before, [add], 'add', added.result)).toBe(true)
    const undoAdd = history.undo()
    expect(undoAdd).toEqual([{ op: 'remove', node: 'n3' }])
    if (undoAdd === undefined) throw new Error('expected the add to be undoable')
    const withoutAdded = applyCanvasOperations(added.document, undoAdd, { limits, now: () => 'now' })
    const redoAdd = history.redo()
    expect(redoAdd).toEqual([add])
    if (redoAdd === undefined) throw new Error('expected the add to be redoable')
    const addedAgain = applyCanvasOperations(withoutAdded.document, redoAdd, { limits, now: () => 'now' })
    expect(addedAgain.result.created).toEqual(['n4'])
    expect(history.refreshAfterRedo(withoutAdded.document, redoAdd, addedAgain.result)).toBe(true)
    const undoAgain = history.undo()
    expect(undoAgain).toEqual([{ op: 'remove', node: 'n4' }])
    if (undoAgain === undefined) throw new Error('expected the redone add to be undoable')
    const addRemovedAgain = applyCanvasOperations(addedAgain.document, undoAgain, { limits, now: () => 'now' })
    expect(addRemovedAgain.result.skipped).toEqual([])
    expect(addRemovedAgain.document.nodes.map(current => current.id)).toEqual(['n1', 'n2'])

    history.clear()
    const group = { op: 'group', title: 'Group', nodes: ['n1', 'n2'] } as const
    const grouped = applyCanvasOperations(before, [group], { limits, now: () => 'now' })
    expect(history.record(before, [group], 'group', grouped.result)).toBe(true)
    const undoGroup = history.undo()
    expect(undoGroup).toEqual([{ op: 'ungroup', node: 'g3' }])
    if (undoGroup === undefined) throw new Error('expected the group to be undoable')
    const ungrouped = applyCanvasOperations(grouped.document, undoGroup, { limits, now: () => 'now' })
    const redoGroup = history.redo()
    expect(redoGroup).toEqual([group])
    if (redoGroup === undefined) throw new Error('expected the group to be redoable')
    const groupedAgain = applyCanvasOperations(ungrouped.document, redoGroup, { limits, now: () => 'now' })
    expect(groupedAgain.result.created).toEqual(['g4'])
    expect(history.refreshAfterRedo(ungrouped.document, redoGroup, groupedAgain.result)).toBe(true)
    const undoGroupAgain = history.undo()
    expect(undoGroupAgain).toEqual([{ op: 'ungroup', node: 'g4' }])
    if (undoGroupAgain === undefined) throw new Error('expected the redone group to be undoable')
    const groupRemovedAgain = applyCanvasOperations(groupedAgain.document, undoGroupAgain, { limits, now: () => 'now' })
    expect(groupRemovedAgain.result.skipped).toEqual([])
    expect(groupRemovedAgain.document.nodes.filter(current => current.type === 'group')).toEqual([])
    expect(groupRemovedAgain.document.nodes.map(current => [current.id, current.group])).toEqual([
      ['n1', undefined], ['n2', undefined],
    ])
  })
  it('restores shot lists with their original ids and positions', () => {
    const board = node('n1', 'storyboard', {
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1'), shot('s2')] }],
      activeVersion: 'v1' as never,
    })
    const doc = document([board])
    expect(invertOperations(doc, [{ op: 'remove_shot', node: 'n1', shot: 's2' as never }])).toEqual([
      { op: 'set_shots', node: 'n1', shots: [shot('s1'), shot('s2')] },
    ])
    expect(invertOperations(doc, [{ op: 'remove_shot', node: 'n1', shot: 's1' as never }])).toEqual([
      { op: 'set_shots', node: 'n1', shots: [shot('s1'), shot('s2')] },
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
    const summary = summaryOf(board, planShotSegments(rowsOf(board)).segments)
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
    expect(moveShotOperations(board, shot('s3').id, shot('s1').id)).toEqual([
      { op: 'move_shot', node: 'n1', shot: 's3', after: 's1' },
    ])
    expect(moveShotOperations(board, shot('s3').id, undefined)).toEqual([
      { op: 'move_shot', node: 'n1', shot: 's3', after: 's1' },
      { op: 'move_shot', node: 'n1', shot: 's1', after: 's3' },
    ])
    expect(moveShotOperations(board, shot('s1').id, undefined)).toEqual([])
    expect(moveShotOperations(board, shot('missing').id, undefined)).toEqual([])
    expect(moveShotOperations(board, shot('s2').id, shot('s2').id)).toEqual([])
  })

  it('moves a row to the front and undoes it with real Host operation semantics', () => {
    const current = node('n1', 'storyboard', {
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1'), shot('s2'), shot('s3')] }],
      activeVersion: 'v1' as never,
    })
    const before = document([current])
    const operations = moveShotOperations(current, shot('s3').id, undefined)
    const limits = resolveConfig({})
    const after = applyCanvasOperations(before, operations, { limits, now: () => 'now' }).document
    expect(rowsOf(after.nodes[0])).toEqual([shot('s3'), shot('s1'), shot('s2')])
    const inverse = invertOperations(before, operations)
    expect(inverse).toEqual([{ op: 'move_shot', node: 'n1', shot: 's3', after: 's2' }])
    const restored = applyCanvasOperations(after, inverse ?? [], { limits, now: () => 'now' }).document
    expect(rowsOf(restored.nodes[0])).toEqual([shot('s1'), shot('s2'), shot('s3')])

    const firstMove = { op: 'move_shot', node: current.id, shot: shot('s1').id, after: shot('s2').id } as const
    const firstMoved = applyCanvasOperations(before, [firstMove], { limits, now: () => 'now' }).document
    expect(rowsOf(firstMoved.nodes[0])).toEqual([shot('s2'), shot('s1'), shot('s3')])
    const firstMoveInverse = invertOperations(before, [firstMove])
    expect(firstMoveInverse).toEqual([
      { op: 'move_shot', node: current.id, shot: shot('s1').id, after: shot('s2').id },
      { op: 'move_shot', node: current.id, shot: shot('s2').id, after: shot('s1').id },
    ])
    const firstRestored = applyCanvasOperations(firstMoved, firstMoveInverse ?? [], { limits, now: () => 'now' }).document
    expect(rowsOf(firstRestored.nodes[0])).toEqual([shot('s1'), shot('s2'), shot('s3')])

    const single = node('single', 'storyboard', {
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1')] }],
      activeVersion: 'v1' as never,
    })
    expect(invertOperations(document([single]), [{
      op: 'move_shot', node: single.id, shot: shot('s1').id,
    }])).toEqual([])
    const removeOperation = { op: 'remove_shot', node: current.id, shot: shot('s1').id } as const
    const removed = applyCanvasOperations(before, [removeOperation], { limits, now: () => 'now' }).document
    const removeInverse = invertOperations(before, [removeOperation])
    const removeRestored = applyCanvasOperations(removed, removeInverse ?? [], { limits, now: () => 'now' }).document
    expect(rowsOf(removeRestored.nodes[0])).toEqual([shot('s1'), shot('s2'), shot('s3')])
  })
})

describe('card view models', () => {
  const video = node('v1', 'video', {
    versions: [
      { id: 'v1' as never, createdAt: 'now', origin: 'user', path: '/a.mp4', durationMs: 1234 },
      { id: 'v2' as never, createdAt: 'now', origin: 'agent', path: '/b.mp4' },
    ],
    activeVersion: 'v2' as never,
  })

  it('offers a version bar only when a node has two versions', () => {
    expect(versionChoices(video).map(choice => [choice.label, choice.active])).toEqual([['v1', false], ['v2', true]])
    expect(versionChoices(node('n1', 'image'))).toEqual([])
    expect(currentVersion(video)).toBe(1)
  })

  it('describes each generation state', () => {
    expect(cardState(undefined, 0)).toEqual({ kind: 'idle' })
    expect(cardState({ state: 'queued', jobId: 'j' as never, at: 'now' }, 0)).toEqual({ kind: 'queued' })
    expect(cardState({ state: 'running', jobId: 'j' as never, at: '2026-11-12T00:00:00.000Z' }, Date.parse('2026-11-12T00:00:05.000Z')))
      .toEqual({ kind: 'running', elapsedMs: 5000 })
    expect(cardState({ state: 'failed', at: 'now', error: 'nope', retryable: false }, 0))
      .toEqual({ kind: 'failed', error: 'nope', retryable: false })
  })

  it('reads script scenes and a short preview', () => {
    const text = '【场1】雨夜\n正文一\n\n【场2】便利店 收银台\n正文二\n正文三'
    expect(scriptScenes(text)).toEqual([{ number: 1, title: '雨夜' }, { number: 2, title: '便利店 收银台' }])
    expect(scriptPreview(text)).toBe('【场1】雨夜\n正文一\n【场2】便利店 收银台')
  })

  it('labels durations and segment badges', () => {
    expect(durationSeconds(1234)).toBe('1.2')
    expect(durationSeconds(undefined)).toBeUndefined()
    const board = node('b1', 'storyboard', {
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1'), shot('s2')] }],
      activeVersion: 'v1' as never,
    })
    const segment = node('v9', 'video', {
      gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'b1' as never, shots: ['s1' as never, 's2' as never] } },
    })
    expect(shotBadge(segment, board, 2, planShotSegments(rowsOf(board)).segments)).toEqual({ scene: 2, segment: 1 })
    expect(shotBadge(segment, undefined, 2)).toEqual({ scene: 2 })
    expect(shotBadge(segment, board, undefined, planShotSegments(rowsOf(board)).segments)).toEqual({ segment: 1 })
    expect(shotBadge(node('x', 'image'))).toBeUndefined()
    expect(storyboardCardView(board).rows).toHaveLength(2)
    expect(storyboardCardView(board).summary.shots).toBe(2)
    expect(groupScene(node('g', 'group', { sceneOrigin: { script: 'n1' as never, scene: 3 } }))).toBe(3)
  })
})


describe('inspector model', () => {
  it('maps a node kind to its gateway operation', () => {
    expect(operationFor('image')).toBe('generate_image')
    expect(operationFor('video')).toBe('generate_video')
    expect(operationFor('speech')).toBe('generate_speech')
    expect(operationFor('music')).toBe('generate_music')
  })

  it('disables a model that cannot take the inputs a node has', () => {
    const capabilities = [
      { id: 'a', model: 't2v', params: [{ id: 'duration' }] },
      { id: 'b', model: 'ref', params: [{ id: 'src_ref_images' }] },
    ]
    expect(modelChoices(capabilities, false, true).map(choice => [choice.model, choice.disabled])).toEqual([['t2v', false], ['ref', false]])
    expect(modelChoices(capabilities, true, true).map(choice => [choice.model, choice.disabled])).toEqual([['t2v', true], ['ref', false]])
  })

  it('builds one control per catalog parameter, seeded from the node or the default', () => {
    const controls = paramControls({
      params: [
        { id: 'duration', options: ['5', '10'], default: '5' },
        { id: 'resolution', options: ['2K'], default: '1K' },
        { id: 'seed', type: 'number', default: '1' },
        { id: 'note' },
      ],
    }, { duration: 8, seed: 7 })
    expect(controls).toEqual([
      { id: 'duration', title: 'duration', kind: 'select', value: '8', options: ['8', '5', '10'] },
      { id: 'resolution', title: 'resolution', kind: 'select', value: '1K', options: ['1K', '2K'] },
      { id: 'seed', title: 'seed', kind: 'number', value: '7' },
      { id: 'note', title: 'note', kind: 'text', value: '' },
    ])
    expect(paramControls(undefined, {})).toEqual([])
  })

  it('builds the generation update from the fields the user edited', () => {
    expect(genOperation({ id: 'n1', gen: { prompt: 'p', params: {} } }, { model: 'm', prompt: 'new', params: { duration: 5 } }))
      .toEqual({ op: 'set_gen', node: 'n1', gen: { model: 'm', prompt: 'new', params: { duration: 5 } } })
    expect(genOperation({ id: 'n1' }, { prompt: 'only' })).toEqual({ op: 'set_gen', node: 'n1', gen: { prompt: 'only' } })
  })

  it('orders references and reads the frame slots', () => {
    const doc = {
      edges: [
        { id: 'b->n:ref', source: 'b', target: 'n', role: 'ref', order: 1 },
        { id: 'a->n:ref', source: 'a', target: 'n', role: 'ref', order: 0 },
        { id: 'f->n:first', source: 'f', target: 'n', role: 'first_frame' },
        { id: 'l->n:last', source: 'l', target: 'n', role: 'last_frame' },
      ],
    }
    expect(orderedRefs(doc, 'n')).toEqual([{ source: 'a', order: 0 }, { source: 'b', order: 1 }])
    expect(frameOf(doc, 'n', 'first_frame')).toBe('f')
    expect(frameOf(doc, 'n', 'last_frame')).toBe('l')
    expect(frameOf(doc, 'n', 'first_frame')).toBe('f')
    expect(reorderOperation('n', ['b', 'a'])).toEqual({ op: 'reorder_refs', node: 'n', sources: ['b', 'a'] })
  })
})

describe('external changes', () => {
  it('names added nodes and only reports a forward revision', () => {
    expect(newNodeIds(undefined, document([node('n1', 'text')]))).toEqual([])
    const before = document([node('n1', 'text')])
    const after = document([node('n1', 'text'), node('n2', 'image')])
    expect(newNodeIds(before, after)).toEqual(['n2'])
    expect(movedForward(undefined, 3)).toBe(false)
    expect(movedForward(2, 2)).toBe(false)
    expect(movedForward(2, 3)).toBe(true)
  })
})

describe('invertOperations coverage of every operation', () => {
  const text = node('t1', 'text', {
    versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', text: 'old' }],
    activeVersion: 'v1' as never,
  })
  const image = node('i1', 'image', {
    versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', path: '/a.png' }],
    activeVersion: 'v1' as never,
    gen: { kind: 'image', prompt: 'p', params: {} },
  })
  const board = node('b1', 'storyboard', {
    versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1'), shot('s2')] }],
    activeVersion: 'v1' as never,
  })
  const group = node('g1', 'group', { title: '组', versions: [] })
  const member = node('m1', 'text', { group: 'g1' as never, versions: [] })
  const doc = document([text, image, board, group, member], [
    { id: 'i1->b1:ref', source: 'i1' as never, target: 'b1' as never, kind: 'reference', role: 'ref', order: 0 },
    { id: 'i1->b1:first_frame', source: 'i1' as never, target: 'b1' as never, kind: 'reference', role: 'first_frame' },
  ])

  it('reverses the state operations from the document they started in', () => {
    expect(invertOperations(doc, [{ op: 'resize', node: 't1', width: 1, height: 1 }])).toEqual([
      { op: 'resize', node: 't1', width: 100, height: 80 },
    ])
    expect(invertOperations(doc, [{ op: 'set_version', node: 't1', version: 'v9' as never }])).toEqual([
      { op: 'set_version', node: 't1', version: 'v1' },
    ])
    expect(invertOperations(doc, [{ op: 'set_gen', node: 'i1', gen: { prompt: 'x', params: {} } }])).toEqual([
      { op: 'set_gen', node: 'i1', gen: { kind: 'image', prompt: 'p', params: {} } },
    ])
    expect(invertOperations(doc, [{ op: 'set_text', node: 't1', text: 'new' }])).toEqual([
      { op: 'set_text', node: 't1', text: 'old' },
    ])
    expect(invertOperations(doc, [{ op: 'update_shot', node: 'b1', shot: 's1' as never, patch: { durationSec: 5 } }]))
      .toEqual([{ op: 'set_shots', node: 'b1', shots: [shot('s1'), shot('s2')] }])
    expect(invertOperations(doc, [{ op: 'insert_shot', node: 'b1', shot: shot('s3') }])).toEqual([
      { op: 'set_shots', node: 'b1', shots: [shot('s1'), shot('s2')] },
    ])
    expect(invertOperations(doc, [{ op: 'remove_shot', node: 'b1', shot: 's2' as never }])).toEqual([
      { op: 'set_shots', node: 'b1', shots: [shot('s1'), shot('s2')] },
    ])
    expect(invertOperations(doc, [{ op: 'move_shot', node: 'b1', shot: 's1' as never }])).toEqual([
      { op: 'move_shot', node: 'b1', shot: 's1', after: 's2' },
      { op: 'move_shot', node: 'b1', shot: 's2', after: 's1' },
    ])
    expect(invertOperations(doc, [{ op: 'disconnect', from: 'i1', to: 'b1', role: 'first_frame' }])).toEqual([
      { op: 'connect', from: 'i1', to: 'b1', kind: 'reference', role: 'first_frame' },
    ])
    expect(invertOperations(doc, [{ op: 'ungroup', node: 'g1' as never }])).toEqual([
      { op: 'group', title: '组', nodes: ['m1'] },
    ])
    expect(invertOperations(doc, [{ op: 'reorder_refs', node: 'b1', sources: [] }])).toEqual([
      { op: 'reorder_refs', node: 'b1', sources: ['i1'] },
    ])
    expect(invertOperations(doc, [{ op: 'group', title: '新组', nodes: ['t1', 'i1'] }], {
      revision: doc.revision + 1, refs: {}, created: [brandString<CanvasNodeId>('g6')], skipped: [],
    })).toEqual([
      { op: 'ungroup', node: 'g6' },
    ])
  })

  it('refuses to reverse an operation whose referent the document lacks', () => {
    const empty = document([])
    for (const operation of [
      { op: 'move', node: 'x', x: 0, y: 0 },
      { op: 'resize', node: 'x', width: 1, height: 1 },
      { op: 'set_version', node: 'x', version: 'v' },
      { op: 'set_gen', node: 'x', gen: { prompt: '', params: {} } },
      { op: 'set_text', node: 'x', text: '' },
      { op: 'set_shots', node: 'x', shots: [] },
      { op: 'remove_shot', node: 'x', shot: 's' },
      { op: 'move_shot', node: 'x', shot: 's' },
      { op: 'disconnect', from: 'a', to: 'b' },
      { op: 'ungroup', node: 'g' },
      { op: 'reorder_refs', node: 'x', sources: [] },
    ] as const) {
      expect(invertOperations(empty, [operation])).toBeUndefined()
    }
    expect(invertOperations(doc, [{
      op: 'insert_shot', node: 't1', shot: shot('s3'),
    }])).toBeUndefined()
    const noVersion = document([node('n', 'text')])
    expect(invertOperations(noVersion, [{ op: 'set_version', node: 'n', version: 'v' }])).toBeUndefined()
    expect(invertOperations(noVersion, [{ op: 'set_text', node: 'n', text: 'x' }])).toBeUndefined()
    expect(invertOperations(noVersion, [{ op: 'set_optional_group' } as never])).toBeUndefined()
    expect(invertOperations(doc, [{ op: 'group', title: 'new', nodes: ['t1', 'i1'] }])).toBeUndefined()
  })

  it('handles skipped edits and unsuccessful redo inverse refreshes', () => {
    const add = { op: 'add', type: 'text', text: 'new' } as const
    const accepted = { revision: doc.revision + 1, refs: {}, created: [], skipped: [] }
    const skipped = { ...accepted, skipped: [{ index: 0, op: 'add' as const, reason: 'ignored' }] }
    expect(invertOperations(doc, [add], skipped)).toEqual([])
    expect(invertOperations(doc, [add], accepted)).toBeUndefined()

    const history = new EditHistory()
    expect(history.refreshAfterRedo(doc, [], accepted)).toBe(false)
    history.record(doc, [{ op: 'move', node: 't1', x: 11, y: 20 }], 'move')
    expect(history.refreshAfterRedo(doc, [{ op: 'move', node: 't1', x: 12, y: 20 }], skipped)).toBe(false)
    expect(history.refreshAfterRedo(doc, [{ op: 'remove', node: 't1' }], accepted)).toBe(false)
  })

  it('treats host-owned operations as not reversible and keeps the empty undo entry', () => {
    for (const operation of [
      { op: 'update', node: 't1', patch: { title: 'x' } },
      { op: 'remove', node: 't1' },
      { op: 'append_version', node: 't1' },
      { op: 'set_stale', node: 't1', stale: true },
      { op: 'set_input_changed', node: 't1' },
      { op: 'set_tail', node: 't1', tail: 'x' },
      { op: 'set_status', node: 't1', status: undefined },
    ] as const) {
      expect(invertOperations(doc, [operation as never])).toBeUndefined()
    }
    const history = new EditHistory()
    history.record(doc, [], '空')
    expect(history.undo()).toBeUndefined()
    expect(history.redo()).toBeUndefined()
    history.record(doc, [{ op: 'move', node: 't1', x: 0, y: 0 }], '移动')
    history.undo()
    expect(history.redo()).toEqual([{ op: 'move', node: 't1', x: 0, y: 0 }])
  })
})

describe('branch coverage of the view models', () => {
  it('reads the current version with and without an active marker', () => {
    expect(currentVersion(node('n', 'image'))).toBe(0)
    const withVersions = node('n', 'image', { versions: [
      { id: 'v1' as never, createdAt: 'now', origin: 'user' },
      { id: 'v2' as never, createdAt: 'now', origin: 'user' },
    ] })
    expect(currentVersion(withVersions)).toBe(1)
    expect(currentVersion({ ...withVersions, activeVersion: 'v1' as never })).toBe(0)
    expect(versionChoices(withVersions)).toEqual([
      { id: 'v1', label: 'v1', active: false }, { id: 'v2', label: 'v2', active: true },
    ])
    expect(versionChoices(node('n', 'image'))).toEqual([])
  })

  it('builds every table cell operation and appends without rows', () => {
    const board = node('b', 'storyboard', { versions: [{
      id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1')],
    }], activeVersion: 'v1' as never })
    expect(cellOperation(board, 's1' as never, 'characters', ['c1'])).toMatchObject({ patch: { characters: ['c1'] } })
    expect(cellOperation(board, 's1' as never, 'scene', 2)).toMatchObject({ patch: { scene: 2 } })
    expect(cellOperation(board, 's1' as never, 'visual', 'v')).toMatchObject({ patch: { visual: 'v' } })
    expect(appendShotOperation(board, blankShot())).toMatchObject({ after: 's1' })
    expect(appendShotOperation(node('b', 'storyboard', { versions: [] }), blankShot())).not.toHaveProperty('after')
    expect(moveShotOperations(board, shot('s1').id, undefined)).toEqual([])
  })

  it('seeds controls from defaults and keeps empty text values', () => {
    expect(paramControls({ params: [{ id: 'a', default: 'x' }, { id: 'b', options: ['1'] }] }, { b: '' })).toEqual([
      { id: 'a', title: 'a', kind: 'text', value: 'x' },
      { id: 'b', title: 'b', kind: 'select', value: '', options: ['1'] },
    ])
    expect(modelChoices([{ id: 'a', model: 'm', params: [{ id: 'src_ref_images' }] }], true, true)).toEqual([
      { id: 'a', model: 'm', disabled: false },
    ])
  })

  it('inverts connects without roles and disconnects without role or order', () => {
    const plain = document([node('a', 'text'), node('b', 'text')], [{
      id: 'a->b:x', source: 'a' as never, target: 'b' as never, kind: 'reference',
    }])
    expect(invertOperations(plain, [{ op: 'connect', from: 'a', to: 'b' }])).toEqual([
      { op: 'disconnect', from: 'a', to: 'b' },
    ])
    expect(invertOperations(plain, [{ op: 'disconnect', from: 'a', to: 'b' }])).toEqual([
      { op: 'connect', from: 'a', to: 'b', kind: 'reference' },
    ])
    expect(invertOperations(plain, [{ op: 'ungroup', node: 'a' }])).toBeUndefined()
    expect(invertOperations(plain, [{ op: 'move_shot', node: 'a', shot: 's' }])).toBeUndefined()
    expect(invertOperations(plain, [{ op: 'remove_shot', node: 'a', shot: 's' }])).toBeUndefined()
  })

  it('rejects malformed two-operation moves that cannot be inverted safely', () => {
    const board = node('b', 'storyboard', {
      versions: [{
        id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1'), shot('s2')],
      }],
      activeVersion: 'v1' as never,
    })
    const documentWithBoard = document([board])
    expect(invertOperations(documentWithBoard, [
      { op: 'move_shot', node: board.id, shot: shot('s1').id, after: shot('s2').id },
      { op: 'move_shot', node: board.id, shot: shot('s2').id, after: shot('s1').id },
    ])).toBeUndefined()
    expect(invertOperations(documentWithBoard, [
      { op: 'move_shot', node: board.id, shot: shot('s1').id, after: shot('s1').id },
      { op: 'move_shot', node: board.id, shot: shot('s1').id, after: shot('s1').id },
    ])).toBeUndefined()
  })

  it('prefers the last shot list when a storyboard has no active version', () => {
    const board = node('b', 'storyboard', { versions: [{
      id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1')],
    }] })
    expect(invertOperations(document([board]), [{ op: 'update_shot', node: 'b', shot: 's1' as never, patch: {} }])).toEqual([
      { op: 'set_shots', node: 'b', shots: [shot('s1')] },
    ])
  })

  it('ignores unknown scene headings and falls back for a missing group scene', () => {
    expect(scriptScenes('无场次\n【场3】夜')).toEqual([{ number: 3, title: '夜' }])
    expect(groupScene(node('g', 'group'))).toBeUndefined()
    expect(shotBadge(node('v', 'video', { gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'b' as never, shots: ['s1' as never] } } }), undefined)).toBeUndefined()
  })
})

describe('ordering and tone fallbacks', () => {
  it('orders references without an order and ignores empty rows', () => {
    const board = node('b', 'storyboard', { versions: [{
      id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1')],
    }], activeVersion: 'v1' as never })
    const doc = document([board, node('a', 'image'), node('c', 'image')], [{
      id: 'a->b:ref', source: 'a' as never, target: 'b' as never, kind: 'reference', role: 'ref',
    }, { id: 'c->b:ref', source: 'c' as never, target: 'b' as never, kind: 'reference', role: 'ref' }])
    expect(invertOperations(doc, [{ op: 'reorder_refs', node: 'b', sources: [] }])).toEqual([
      { op: 'reorder_refs', node: 'b', sources: ['a', 'c'] },
    ])
    expect(rowsOf(undefined)).toEqual([])
    expect(segmentTone([], 's1' as never)).toBe(0)
    expect(segmentTone([{ shots: ['s1' as never] } as never], 's1' as never)).toBe(0)
  })
})

describe('generation update fields', () => {
  it('keeps only the fields a caller changed', () => {
    expect(genOperation({ id: 'n' }, { model: 'm' })).toEqual({ op: 'set_gen', node: 'n', gen: { model: 'm' } })
    expect(genOperation({ id: 'n' }, { params: { a: 1 } })).toEqual({ op: 'set_gen', node: 'n', gen: { params: { a: 1 } } })
    expect(genOperation({ id: 'n' }, {})).toEqual({ op: 'set_gen', node: 'n', gen: {} })
  })
})

describe('reference order defaults', () => {
  it('orders references that carry no order value', () => {
    const doc = document([node('a', 'image'), node('b', 'video')], [{
      id: 'a->b:ref', source: 'a' as never, target: 'b' as never, kind: 'reference', role: 'ref',
    }])
    expect(orderedRefs(doc, 'b')).toEqual([{ source: 'a', order: 0 }])
  })
})

describe('reference order with an explicit order', () => {
  it('keeps the stored order value', () => {
    const doc = document([node('a', 'image'), node('b', 'video')], [{
      id: 'a->b:ref', source: 'a' as never, target: 'b' as never, kind: 'reference', role: 'ref', order: 3,
    }])
    expect(orderedRefs(doc, 'b')).toEqual([{ source: 'a', order: 3 }])
  })
})

describe('reference ordering of several unordered refs', () => {
  it('uses zero for both comparands when no edge carries an order', () => {
    const doc = document([node('a', 'image'), node('b', 'image'), node('v', 'video')], [{
      id: 'a->v:ref', source: 'a' as never, target: 'v' as never, kind: 'reference', role: 'ref',
    }, { id: 'b->v:ref', source: 'b' as never, target: 'v' as never, kind: 'reference', role: 'ref' }])
    expect(orderedRefs(doc, 'v').map(item => item.source)).toEqual(['a', 'b'])
  })
})
