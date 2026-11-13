// @vitest-environment jsdom
/** The canvas tab shows reading, failure, empty, and drawn states, and its notices keep the document visible. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasDocument, CanvasOperation } from '@deepseek-ai/dsh-canvas/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BibleEntryId, CanvasNodeId, ShotId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import { applyOperations } from '../../../media/canvas/src/operations.ts'
import { resolveConfig } from '../../../media/canvas/src/config.ts'
import { CanvasBody, type CanvasBodyProps } from '../src/client/CanvasBody.tsx'
import { CanvasTitle } from '../src/client/CanvasTitle.tsx'
import type { CanvasEditOptions, CanvasState } from '../src/client/canvas-source.ts'
import type { CanvasFlowProps } from '../src/client/CanvasFlow.tsx'

const drawn = vi.hoisted(() => vi.fn((_props: unknown) => null))
vi.mock('../src/client/CanvasFlow.tsx', () => ({ CanvasFlow: drawn }))

afterEach(() => { cleanup(); drawn.mockClear() })

const empty: CanvasDocument = { version: 2, revision: 0, nextId: 1, nodes: [], edges: [] }
const filled: CanvasDocument = {
  version: 2, revision: 0, nextId: 2, edges: [],
  nodes: [{
    id: 'n1' as never, type: 'text', title: 'Brief', x: 0, y: 0, width: 280, height: 160,
    activeVersion: 'v1' as never,
    versions: [{ id: 'v1' as never, text: 'brief', createdAt: 'now', origin: 'user' }],
  }],
}
const view = { directory: '/project', episode: { id: 'e1', title: 'Canvas' }, revisions: { canvas: 0 }, document: filled, segments: {} }
const emptyView = { ...view, document: empty }

const fieldValue = (label: string): string => {
  const field = screen.getByLabelText(label)
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
    return field.value
  }
  throw new Error(`expected ${label} to label a form field`)
}

function mount(initial: Partial<CanvasState>, extra: Record<string, unknown> = {}) {
  const state = createSnapshotStore<CanvasState>({
    status: 'loading', view: undefined, error: undefined, notice: undefined, conflict: false, ...initial,
  })
  const load = vi.fn(async () => {}), dismiss = vi.fn(), readFile = vi.fn()
  const edit = vi.fn(async (operations: readonly CanvasOperation[], options?: CanvasEditOptions) => {
    const current = state.getSnapshot()
    const currentView = current.view
    if (currentView === undefined) return
    const settled = applyOperations(currentView.document, [...operations], { limits: resolveConfig({}), now: () => 'now' })
    options?.onApplied?.(currentView.document, operations, settled.result)
    state.set({
      ...current,
      view: {
        ...currentView, document: settled.document,
        revisions: { ...currentView.revisions, canvas: settled.document.revision },
      },
    })
  })
  const capabilities = vi.fn(async () => [])
  const bible = vi.fn(async () => ({ bible: { version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' }, entries: [] }, revision: 0 }))
  const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${String(params.message)}`
  const props = {
    useCanvas: (select: (value: CanvasState) => unknown) => select(state.getSnapshot()), load, edit, dismiss, readFile,
    capabilities, bible, t, ...extra,
  } as never as CanvasBodyProps
  const view = render(<CanvasBody {...props} />)
  return { state, load, edit, dismiss, readFile, capabilities, bible, t, rerender: () => { view.rerender(<CanvasBody {...props} />) } }
}

it('reads the canvas on mount and shows a spinner until the first read settles', () => {
  const h = mount({})
  expect(h.load).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe('loading')
})

it('shows a failed first read with a retry', () => {
  const h = mount({ status: 'failed', error: 'canvas file is corrupt' })
  expect(screen.getByRole('alert').textContent).toBe('failed:canvas file is corrupt')
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  expect(h.load).toHaveBeenCalledTimes(2)
})

it('explains an empty canvas without loading the flow', () => {
  mount({ status: 'ready', view: emptyView as never })
  expect(screen.getByText('empty')).toBeTruthy()
  expect(drawn).not.toHaveBeenCalled()
})

it('draws a canvas with nodes through the lazily loaded flow', async () => {
  const h = mount({ status: 'ready', view: view as never })
  await waitFor(() => { expect(drawn).toHaveBeenCalled() })
  const props = drawn.mock.calls[0]![0] as CanvasFlowProps
  expect(props).toMatchObject({ document: filled, readFile: h.readFile, t: h.t, reload: h.load })
  expect(props.edit).not.toBe(h.edit)
  expect(props.historyEdit).toBeTypeOf('function')
})

it('keeps the document drawn under a failed refresh and under an edit notice that can be dismissed', async () => {
  const h = mount({ status: 'failed', error: 'offline', notice: 'the edge would form a cycle', view: view as never })
  await waitFor(() => { expect(drawn).toHaveBeenCalled() })
  expect(screen.getAllByRole('alert').map(alert => alert.textContent)).toEqual(['failed:offlineretry', 'notice:the edge would form a cycle'])
  fireEvent.click(screen.getByRole('button', { name: 'dismiss' }))
  expect(h.dismiss).toHaveBeenCalledOnce()
})

it('titles the tab with the layers icon and the tab title', () => {
  const props: Parameters<typeof CanvasTitle>[0] = { useTabInfo: () => ({ tab: { title: 'Canvas' } }) } as never
  const { container } = render(<CanvasTitle {...props} />)
  expect(container.querySelector('svg')).not.toBeNull()
  expect(container.textContent).toBe('Canvas')
})

it('toggles the fullscreen studio without replacing the flow', () => {
  mount({ status: 'ready', view: view as never })
  const toggle = screen.getByRole('button', { name: 'canvas.fullscreen' })
  fireEvent.click(toggle)
  expect(document.querySelector('[data-sidebar-canvas]')?.getAttribute('data-fullscreen')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'canvas.exitFullscreen' }))
  expect(document.querySelector('[data-sidebar-canvas]')?.getAttribute('data-fullscreen')).toBeNull()
  expect(drawn.mock.calls.every(call => (call[0] as { document: unknown }).document === filled)).toBe(true)
})

it('reports nodes an external change added', async () => {
  const h = mount({ status: 'ready', view: view as never })
  const next = {
    ...view,
    revisions: { canvas: 1 },
    document: {
      ...filled,
      revision: 1,
      nodes: [...filled.nodes, {
        id: 'n2' as never, type: 'text' as const, title: 'New', x: 0, y: 0, width: 100, height: 60,
        activeVersion: 'v1' as never, versions: [{ id: 'v1' as never, text: 'new', createdAt: 'now', origin: 'user' as const }],
      }],
    },
  }
  h.state.set({ ...h.state.getSnapshot(), view: next as never })
  h.rerender()
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('canvas.added') })
})

it('opens the bible panel with the shared entries', async () => {
  const h = mount({ status: 'ready', view: view as never })
  fireEvent.click(screen.getByRole('button', { name: 'bible.tab' }))
  await waitFor(() => { expect(h.bible).toHaveBeenCalledOnce() })
  expect(screen.getByRole('tab', { name: 'bible.tab' })).toBeTruthy()
})

it('moves from the loading pane to the drawn canvas without changing hook order', async () => {
  const h = mount({})
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe('loading')
  h.state.set({ status: 'ready', view: view as never, error: undefined, notice: undefined, conflict: false })
  h.rerender()
  await waitFor(() => { expect(drawn).toHaveBeenCalled() })
})

const boardDoc: CanvasDocument = {
  version: 2, revision: 0, nextId: 3, edges: [],
  nodes: [{
    id: 'b1' as never, type: 'storyboard', title: '场1 分镜', x: 0, y: 0, width: 320, height: 200,
    activeVersion: 'v1' as never,
    versions: [{
      id: 'v1' as never, createdAt: 'now', origin: 'user',
      shots: [{
        id: 's1' as never, title: 's1', shotSize: 'medium', visual: '画面', motion: '动作', camera: '固定',
        durationSec: 3, characters: [], props: [], dialogue: [], sfx: '', negative: '',
      }],
    }],
  }],
}
const boardView = { ...view, document: boardDoc, segments: { b1: [{ shots: ['s1'] }, { shots: ['s2'] }] } }

it('exports the canvas as a JSON download', () => {
  const create = vi.fn(() => 'blob:canvas')
  const revoke = vi.fn()
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
  mount({ status: 'ready', view: view as never })
  fireEvent.click(screen.getByRole('button', { name: 'canvas.export' }))
  expect(create).toHaveBeenCalledOnce()
  expect(revoke).toHaveBeenCalledWith('blob:canvas')
})

it('opens the storyboard table for the selected node and hides the canvas actions', async () => {
  mount({ status: 'ready', view: boardView as never })
  const flow = drawn.mock.calls[0]![0] as CanvasFlowProps & { onSelect: (id: string) => void }
  expect(flow.segments).toEqual(boardView.segments)
  act(() => { flow.onSelect('b1') })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'inspector.openTable' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.openTable' }))
  expect(screen.getByRole('button', { name: 'table.addRow' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'canvas.export' })).toBeNull()
})

it('records storyboard table edits in the CanvasBody-owned history', async () => {
  mount({ status: 'ready', view: boardView as never })
  const flow = drawn.mock.calls[0]![0] as CanvasFlowProps & { onSelect: (id: string) => void }
  act(() => { flow.onSelect('b1') })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.openTable' }))
  fireEvent.change(screen.getAllByRole('combobox')[0] as HTMLElement, { target: { value: 'wide' } })
  expect(flow.history?.canUndo()).toBe(true)
  expect(flow.history?.undo()).toEqual([{ op: 'set_shots', node: 'b1', shots: boardDoc.nodes[0]?.versions?.[0]?.shots }])
})

it('records inspector parameter edits in the CanvasBody-owned history', async () => {
  const video: CanvasDocument = {
    version: 2, revision: 0, nextId: 2, edges: [],
    nodes: [{
      id: brandString<CanvasNodeId>('v1'), type: 'video', title: 'Video', x: 0, y: 0, width: 280, height: 200,
      gen: { kind: 'video', model: 'model', prompt: 'old', params: { seed: 1 } },
    }],
  }
  const mediaView = { ...view, document: video }
  const capabilities = vi.fn(async () => [{
    id: 'cap', model: 'model', operation: 'generate_video', params: [],
  }])
  mount({ status: 'ready', view: mediaView as never }, { capabilities })
  const flow = drawn.mock.calls[0]![0] as CanvasFlowProps & { onSelect: (id: string) => void }
  act(() => { flow.onSelect('v1') })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'inspector.apply' })).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('inspector.prompt'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.apply' }))
  expect(flow.history?.canUndo()).toBe(true)
  expect(flow.history?.undo()).toEqual([{
    op: 'set_gen', node: 'v1', gen: { kind: 'video', model: 'model', prompt: 'old', params: { seed: 1 } },
  }])
})

it('refreshes the selected inspector after local undo and redo', async () => {
  const storyboard = {
    id: brandString<CanvasNodeId>('b1'), type: 'storyboard' as const, title: 'Board', x: 0, y: 0, width: 320, height: 200,
    activeVersion: brandString<VersionId>('v1'),
    versions: [{
      id: brandString<VersionId>('v1'), createdAt: 'now', origin: 'user' as const,
      shots: [{
        id: brandString<ShotId>('s1'), title: 's1', shotSize: 'medium' as const, visual: 'visual', motion: 'motion',
        camera: 'camera', durationSec: 3, characters: [], props: [], dialogue: [], sfx: '', negative: '',
      }],
    }],
  }
  const video: CanvasDocument = {
    version: 2, revision: 0, nextId: 3, edges: [],
    nodes: [
      { id: brandString<CanvasNodeId>('v1'), type: 'video', title: 'Video', x: 0, y: 0, width: 280, height: 200,
        gen: { kind: 'video', model: 'model', prompt: 'old', params: { seed: 1 } } },
      storyboard,
    ],
  }
  const boardVersion = storyboard.versions[0]
  if (boardVersion === undefined) throw new Error('expected a storyboard version')
  const mediaView = { ...view, document: video }
  const capabilities = vi.fn(async () => [{ id: 'cap', model: 'model', operation: 'generate_video', params: [] }])
  mount({ status: 'ready', view: mediaView as never }, { capabilities })
  const firstFlow = drawn.mock.calls.at(-1)?.[0] as CanvasFlowProps & { onSelect: (id: string) => void }
  act(() => { firstFlow.onSelect('v1') })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'inspector.apply' })).toBeTruthy() })
  fireEvent.change(screen.getByLabelText('inspector.prompt'), { target: { value: 'new' } })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.apply' }))
  const selectedFlow = drawn.mock.calls.at(-1)?.[0] as CanvasFlowProps
  const undo = selectedFlow.history?.undo()
  expect(undo).toEqual([{
    op: 'set_gen', node: 'v1', gen: { kind: 'video', model: 'model', prompt: 'old', params: { seed: 1 } },
  }])
  if (undo === undefined) throw new Error('expected the generation edit to be undoable')
  const undoEdit = selectedFlow.historyEdit
  if (undoEdit === undefined) throw new Error('expected a local history edit callback')
  await act(async () => { await undoEdit(undo, 'undo') })
  expect(fieldValue('inspector.prompt')).toBe('old')
  const redoneFlow = drawn.mock.calls.at(-1)?.[0] as CanvasFlowProps
  const redo = redoneFlow.history?.redo()
  expect(redo).toEqual([{
    op: 'set_gen', node: 'v1', gen: { model: 'model', prompt: 'new', params: { seed: 1 } },
  }])
  if (redo === undefined) throw new Error('expected the generation edit to be redoable')
  const redoEdit = redoneFlow.historyEdit
  if (redoEdit === undefined) throw new Error('expected a local history edit callback')
  await act(async () => { await redoEdit(redo, 'redo') })
  expect(fieldValue('inspector.prompt')).toBe('new')
  fireEvent.change(screen.getByLabelText('inspector.prompt'), { target: { value: 'unsaved' } })
  await act(async () => {
    await redoEdit([{ op: 'set_shots', node: 'b1', shots: boardVersion.shots }], 'undo')
    await redoEdit([{
      op: 'set_gen', node: 'v1', gen: { prompt: 'x'.repeat(resolveConfig({}).maxPromptLength + 1) },
    }], 'undo')
  })
  expect(fieldValue('inspector.prompt')).toBe('unsaved')
})

it('records Bible asset creation in the CanvasBody-owned history', async () => {
  const entryId = brandString<BibleEntryId>('c1')
  const bible = vi.fn(async () => ({
    bible: {
      version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' },
      entries: [{ id: entryId, kind: 'character' as const, name: 'Ada', description: 'A character' }],
    },
    revision: 0,
  }))
  mount({ status: 'ready', view: view as never }, { bible })
  const flow = drawn.mock.calls[0]![0] as CanvasFlowProps
  fireEvent.click(screen.getByRole('button', { name: 'bible.tab' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'bible.threeView' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'bible.threeView' }))
  expect(flow.history?.canUndo()).toBe(true)
  expect(flow.history?.undo()).toEqual([{ op: 'remove', node: 'n2' }])
})

it('passes generation callbacks to the inspector and dispatches a refit on fullscreen', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'ready' as const, lines: [], totals: { videoCalls: 1, videoSeconds: 3, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn(async () => undefined)
  mount({ status: 'ready', view: boardView as never }, { planNodes, generateNodes })
  const flow = drawn.mock.calls[0]![0] as CanvasFlowProps & { onSelect: (id: string) => void }
  act(() => { flow.onSelect('b1') })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'inspector.generateNow' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(planNodes).toHaveBeenCalledWith(['b1']) })
  await waitFor(() => { expect(generateNodes).toHaveBeenCalledWith(['b1'], undefined) })
  const fit = vi.fn()
  window.addEventListener('canvas:fit', fit)
  fireEvent.click(screen.getByRole('button', { name: 'canvas.fullscreen' }))
  await waitFor(() => { expect(fit).toHaveBeenCalled() })
  window.removeEventListener('canvas:fit', fit)
})

it('closes the inspector, the table, and the bible panel through their own controls', async () => {
  mount({ status: 'ready', view: boardView as never })
  const flow = drawn.mock.calls[0]![0] as CanvasFlowProps & { onSelect: (id: string) => void }
  act(() => { flow.onSelect('b1') })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'inspector.close' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.close' }))
  expect(screen.queryByRole('button', { name: 'inspector.close' })).toBeNull()
  act(() => { flow.onSelect('b1') })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.openTable' }))
  fireEvent.click(screen.getByRole('button', { name: 'table.close' }))
  expect(screen.queryByRole('button', { name: 'table.addRow' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'bible.tab' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'bible.close' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'bible.close' }))
  expect(screen.queryByRole('button', { name: 'bible.close' })).toBeNull()
})

it('loads the bible lazily, recovers from a failed read, and selects an asset', async () => {
  const bible = vi.fn()
    .mockRejectedValueOnce(new Error('bible down'))
    .mockResolvedValue({ bible: { version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' }, entries: [] }, revision: 0 })
  const withImage = { ...boardView, document: { ...boardDoc, nodes: [...boardDoc.nodes, {
    id: 'im1' as never, type: 'image' as const, title: '参考图', x: 0, y: 0, width: 1, height: 1,
  }] } }
  mount({ status: 'ready', view: withImage as never }, { bible })
  fireEvent.click(screen.getByRole('button', { name: 'bible.tab' }))
  await waitFor(() => { expect(bible).toHaveBeenCalledOnce() })
  fireEvent.click(screen.getByRole('button', { name: 'bible.close' }))
  fireEvent.click(screen.getByRole('button', { name: 'bible.tab' }))
  await waitFor(() => { expect(bible).toHaveBeenCalledTimes(2) })
  fireEvent.click(screen.getByRole('tab', { name: 'assets.tab' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: '参考图' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: '参考图' }))
  await waitFor(() => { expect(screen.getByRole('button', { name: 'inspector.close' })).toBeTruthy() })
})

it('shows and clears the added-node badge after an external change', async () => {
  const h = mount({ status: 'ready', view: view as never })
  const next = { ...view, revisions: { canvas: 1 }, document: { ...filled, revision: 1, nodes: [...filled.nodes, {
    id: 'n2' as never, type: 'text' as const, title: 'New', x: 0, y: 300, width: 100, height: 60,
    activeVersion: 'v1' as never, versions: [{ id: 'v1' as never, text: 'new', createdAt: 'now', origin: 'user' as const }],
  }] } }
  h.state.set({ ...h.state.getSnapshot(), view: next as never })
  h.rerender()
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('canvas.added') })
  await new Promise(resolve => setTimeout(resolve, 1600))
  expect(screen.queryByRole('status')).toBeNull()
})

it('shows the conflict copy when the last edit lost to another writer', () => {
  mount({ status: 'ready', view: view as never, notice: 'revision changed', conflict: true })
  expect(screen.getByRole('alert').textContent).toContain('conflict')
  cleanup()
  mount({ status: 'ready', view: view as never, notice: 'skipped edge', conflict: false })
  expect(screen.getByRole('alert').textContent).toContain('notice')
})

it('exports with the canvas name when the episode is unknown', () => {
  const create = vi.fn(() => 'blob:x')
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() })
  mount({ status: 'ready', view: { ...view, episode: undefined } as never })
  fireEvent.click(screen.getByRole('button', { name: 'canvas.export' }))
  expect(create).toHaveBeenCalled()
})

it('reuses the loaded bible when the panel opens again', async () => {
  const bible = vi.fn(async () => ({ bible: { version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' }, entries: [] }, revision: 0 }))
  mount({ status: 'ready', view: view as never }, { bible })
  fireEvent.click(screen.getByRole('button', { name: 'bible.tab' }))
  await waitFor(() => { expect(bible).toHaveBeenCalledOnce() })
  fireEvent.click(screen.getByRole('button', { name: 'bible.close' }))
  fireEvent.click(screen.getByRole('button', { name: 'bible.tab' }))
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(bible).toHaveBeenCalledOnce()
})
