// @vitest-environment jsdom
/** The gesture hook turns xyflow callbacks and key presses into canvas edits. */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import type { Edge, Node } from '@xyflow/react'
import { useGestures } from '../src/client/useGestures.ts'
import { EditHistory } from '../src/client/model/history.ts'

afterEach(() => { cleanup() })

const doc: CanvasDocument = {
  version: 2, revision: 1, nextId: 4, edges: [],
  nodes: [
    { id: 'n1' as never, type: 'image', title: 'a.png', x: 0, y: 0, width: 280, height: 260, activeVersion: 'v1' as never, versions: [] },
    { id: 'n2' as never, type: 'video', title: 'v.mp4', x: 400, y: 0, width: 280, height: 220, activeVersion: 'v1' as never, versions: [] },
  ],
}

function setup(overrides: Partial<Parameters<typeof useGestures<Node, Edge>>[0]> = {}) {
  const apply = vi.fn(async () => {})
  const edit = vi.fn(async () => {})
  const setNodes = vi.fn()
  const setEdges = vi.fn()
  const history = new EditHistory()
  history.record(doc, [{ op: 'move', node: 'n1', x: 5, y: 5 }], '移动')
  const hook = renderHook(() => useGestures<Node, Edge>({
    document: doc, apply, edit, setNodes, setEdges, confirmDelete: count => `删除 ${String(count)}`,
    groupTitle: '新组',
    nodes: [
      { id: 'n1', position: { x: 0, y: 0 }, data: {}, selected: true },
      { id: 'n2', position: { x: 0, y: 0 }, data: {}, selected: true },
    ],
    ...overrides,
    ...overrides.history === undefined ? { history: overrides.history ?? history } : {},
  }))
  return { hook, apply, edit, setNodes, setEdges, history }
}

it('undoes, redoes, and groups through the keyboard listener', () => {
  const h = setup()
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true })) })
  expect(h.edit).toHaveBeenCalledWith([{ op: 'move', node: 'n1', x: 0, y: 0 }])
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true })) })
  expect(h.edit).toHaveBeenCalledWith([{ op: 'move', node: 'n1', x: 5, y: 5 }])
  act(() => { h.history.redo() })
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' })) })
  expect(h.apply).toHaveBeenCalledWith([{ op: 'group', title: '新组', nodes: ['n1', 'n2'] }])
})

it('ignores keys typed into form controls and without a selection', () => {
  const h = setup()
  const input = document.createElement('input')
  document.body.append(input)
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true })) })
  expect(h.apply).not.toHaveBeenCalled()
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' })) })
  expect(h.apply).toHaveBeenCalledTimes(1)
})

it('plays or pauses the selected media element with Space', () => {
  setup({ nodes: [{ id: 'n2', position: { x: 0, y: 0 }, data: {}, selected: true }] })
  const video = document.createElement('video')
  const play = vi.fn(async () => {})
  const pause = vi.fn()
  Object.defineProperty(video, 'paused', { get: () => false, configurable: true })
  video.play = play
  video.pause = pause
  const wrapper = document.createElement('div')
  wrapper.className = 'react-flow__node'
  wrapper.dataset.id = 'n2'
  wrapper.append(video)
  document.body.append(wrapper)
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })) })
  expect(pause).toHaveBeenCalled()
  Object.defineProperty(video, 'paused', { get: () => true, configurable: true })
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })) })
  expect(play).toHaveBeenCalled()
})

it('ignores Space without a selected media element', () => {
  const h = setup({ nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data: {}, selected: true }] })
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })) })
  expect(h.apply).not.toHaveBeenCalled()
})

it('connects immediately, opens the role menu, and ignores a missing node', () => {
  const h = setup()
  act(() => { h.hook.result.current.onConnectStart({ clientX: 10, clientY: 20 } as never, { nodeId: 'n1' } as never) })
  act(() => { h.hook.result.current.onConnectEnd({ clientX: 30, clientY: 40 } as never, undefined as never) })
  act(() => { h.hook.result.current.onConnect({ source: 'n1', target: 'n2' } as never) })
  expect(h.hook.result.current.menu).toMatchObject({ x: 30, y: 40, source: 'n1', target: 'n2' })
  act(() => { h.hook.result.current.setMenu(undefined) })
  act(() => { h.hook.result.current.onConnect({ source: 'n1', target: 'missing' } as never) })
  expect(h.apply).not.toHaveBeenCalled()
})

it('applies a plain connection and reports the drag stop', () => {
  const plain: CanvasDocument = { ...doc, nodes: [doc.nodes[0]!, { ...doc.nodes[1]!, type: 'text' }] }
  const h = setup({ document: plain, nodes: [] })
  act(() => { h.hook.result.current.onConnect({ source: 'n1', target: 'n2' } as never) })
  expect(h.apply).toHaveBeenCalledWith([{ op: 'connect', from: 'n1', to: 'n2' }])
  act(() => { h.hook.result.current.onNodeDragStop({} as never, {} as never, [{ id: 'n1', position: { x: 7, y: 8 } }] as never) })
  expect(h.apply).toHaveBeenCalled()
})

it('asks before deleting, respects a refusal, and forwards node and edge changes', async () => {
  const h = setup()
  window.confirm = vi.fn(() => false)
  await act(async () => { await h.hook.result.current.onBeforeDelete({ nodes: [{ id: 'n1' }] as never, edges: [] }) })
  expect(h.apply).not.toHaveBeenCalled()
  window.confirm = vi.fn(() => true)
  await act(async () => { await h.hook.result.current.onBeforeDelete({ nodes: [{ id: 'n1' }] as never, edges: [] }) })
  expect(h.apply).toHaveBeenCalled()
  const updates: unknown[] = []
  const withSetter = setup({ setNodes: (update) => { updates.push(update) }, setEdges: (update) => { updates.push(update) } })
  act(() => {
    withSetter.hook.result.current.onNodesChange([
      { type: 'position', id: 'n1', position: { x: 1, y: 2 } },
      { type: 'select', id: 'n1', selected: true },
      { type: 'dimensions', id: 'n1', dimensions: { width: 1, height: 1 } },
    ] as never)
    withSetter.hook.result.current.onEdgesChange([{ type: 'select', id: 'e1', selected: true }] as never)
  })
  expect(updates).toHaveLength(2)
  expect(typeof updates[0]).toBe('function')
})

it('connects the pending pair with the picked role, and dismisses without editing', () => {
  const h = setup()
  act(() => { h.hook.result.current.onConnect({ source: 'n1', target: 'n2' } as never) })
  act(() => { h.hook.result.current.pickRole('first_frame') })
  expect(h.apply).toHaveBeenCalledWith([{
    op: 'connect', from: 'n1', to: 'n2', kind: 'reference', role: 'first_frame',
  }])
  act(() => { h.hook.result.current.dismissMenu() })
  expect(h.hook.result.current.menu).toBeUndefined()
})

it('dismisses a role pick without a pending menu and skips an empty deletion', async () => {
  const h = setup()
  act(() => { h.hook.result.current.pickRole('ref') })
  expect(h.apply).not.toHaveBeenCalled()
  await act(async () => { await h.hook.result.current.onBeforeDelete({ nodes: [], edges: [] }) })
  expect(h.apply).not.toHaveBeenCalled()
})

it('keeps an edge that receives a non-select change', () => {
  const updates: unknown[] = []
  const h = setup({ setEdges: (update) => { updates.push(update) }, nodes: [] })
  act(() => { h.hook.result.current.onEdgesChange([{ type: 'remove', id: 'e1' }] as never) })
  expect(typeof updates[0]).toBe('function')
  expect((updates[0] as (current: unknown[]) => unknown[])([{ id: 'e1' }])).toEqual([{ id: 'e1' }])
})

it('swallows a rejected play request', async () => {
  setup({ nodes: [{ id: 'n2', position: { x: 0, y: 0 }, data: {}, selected: true }] })
  const video = document.createElement('video')
  Object.defineProperty(video, 'paused', { get: () => true, configurable: true })
  video.play = vi.fn(async () => { throw new Error('blocked') })
  const wrapper = document.createElement('div')
  wrapper.className = 'react-flow__node'
  wrapper.dataset.id = 'n2'
  wrapper.append(video)
  document.body.append(wrapper)
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })) })
  await Promise.resolve()
})

it('applies position and select updates to the flow nodes and edges', () => {
  let nodesUpdate: ((current: Node[]) => Node[]) | undefined
  let edgesUpdate: ((current: Edge[]) => Edge[]) | undefined
  const h = setup({
    setNodes: (update) => { nodesUpdate = update },
    setEdges: (update) => { edgesUpdate = update },
  })
  act(() => {
    h.hook.result.current.onNodesChange([
      { type: 'position', id: 'n1', position: { x: 3, y: 4 } },
      { type: 'select', id: 'n2', selected: true },
      { type: 'dimensions', id: 'n1', dimensions: { width: 1, height: 1 } },
    ] as never)
    h.hook.result.current.onEdgesChange([{ type: 'select', id: 'e1', selected: true }] as never)
  })
  const nodes = nodesUpdate!([{ id: 'n1', position: { x: 0, y: 0 }, data: {} }, { id: 'n2', position: { x: 0, y: 0 }, data: {} }] as Node[])
  expect(nodes[0]).toMatchObject({ position: { x: 3, y: 4 } })
  expect(nodes[1]).toMatchObject({ selected: true })
  const edges = edgesUpdate!([{ id: 'e1' }] as Edge[])
  expect(edges[0]).toMatchObject({ selected: true })
})
