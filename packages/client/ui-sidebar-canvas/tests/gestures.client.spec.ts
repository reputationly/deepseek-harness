/** Gesture decisions turn a dropped connection, a key press, and a delete into edits. */
import { expect, it } from 'vitest'
import type { CanvasDocument, CanvasNode } from '@deepseek-ai/dsh-canvas/client'
import { connectionIntent, deleteIntent, keyboardIntent } from '../src/client/model/gestures.ts'
import { scriptScenes } from '../src/client/model/cards.ts'

const node = (id: string, type: CanvasNode['type'], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id: id as never, type, title: id, x: 0, y: 0, width: 100, height: 100, ...extra,
})
const document = (nodes: readonly CanvasNode[], edges: CanvasDocument['edges'] = []): CanvasDocument => ({
  version: 2, revision: 1, nextId: nodes.length + 1, nodes, edges,
})
const key = (overrides: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) => ({
  key: 'z', metaKey: false, ctrlKey: false, shiftKey: false, ...overrides,
})

it('connects a pair that has no role meaning, ignores a missing node, and asks for a menu otherwise', () => {
  expect(connectionIntent(document([node('a', 'text'), node('b', 'text')]), { source: 'a', target: 'b' }))
    .toEqual({ kind: 'apply', operations: [{ op: 'connect', from: 'a', to: 'b' }] })
  expect(connectionIntent(document([node('a', 'text')]), { source: 'a', target: 'z' })).toEqual({ kind: 'ignore' })
  expect(connectionIntent(document([node('a', 'image'), node('b', 'video')]), { source: 'a', target: 'b' })).toEqual({
    kind: 'menu', source: 'a', target: 'b',
  })
})

it('connects automatically when only one role is left', () => {
  const doc = document([node('a', 'image'), node('b', 'video')], [{
    id: 'a->b:ref', source: 'a' as never, target: 'b' as never, kind: 'reference', role: 'ref',
  }, {
    id: 'a->b:first', source: 'a' as never, target: 'b' as never, kind: 'reference', role: 'first_frame',
  }])
  expect(connectionIntent(doc, { source: 'a', target: 'b' })).toEqual({
    kind: 'apply', operations: [{ op: 'connect', from: 'a', to: 'b', kind: 'reference', role: 'last_frame' }],
  })
})

it('maps keyboard gestures onto undo, redo, and grouping', () => {
  const doc = document([node('a', 'text'), node('b', 'text')])
  expect(keyboardIntent(key({ metaKey: true }), doc, [], '新组')).toEqual({ kind: 'undo' })
  expect(keyboardIntent(key({ metaKey: true, key: 'Z' }), doc, [], '新组')).toEqual({ kind: 'undo' })
  expect(keyboardIntent(key({ ctrlKey: true, shiftKey: true }), doc, [], '新组')).toEqual({ kind: 'redo' })
  expect(keyboardIntent(key({ key: 'g' }), doc, ['a'], '新组')).toEqual({ kind: 'ignore' })
  expect(keyboardIntent(key({ key: 'G' }), doc, ['a', 'b'], '新组')).toEqual({
    kind: 'group', operations: [{ op: 'group', title: '新组', nodes: ['a', 'b'] }],
  })
  expect(keyboardIntent(key({ key: 'x' }), doc, ['a', 'b'], '新组')).toEqual({ kind: 'ignore' })
  expect(keyboardIntent(key({ metaKey: true, key: 'g' }), doc, ['a', 'b'], '新组')).toEqual({ kind: 'ignore' })
})

it('names the deletion it asks the user to confirm, or reports nothing to delete', () => {
  const doc = document([node('a', 'text')])
  expect(deleteIntent(doc, [], [])).toBeUndefined()
  expect(deleteIntent(doc, ['a'], [])).toMatchObject({ removing: 1 })
  expect(deleteIntent(doc, ['missing'], [])).toBeUndefined()
})

it('reads full-width scene numbers from a script', () => {
  expect(scriptScenes('【场１２】雨夜\n普通行\n【场2】清晨')).toEqual([{ number: 12, title: '雨夜' }, { number: 2, title: '清晨' }])
})
