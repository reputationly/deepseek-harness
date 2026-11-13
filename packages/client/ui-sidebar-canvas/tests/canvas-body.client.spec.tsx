// @vitest-environment jsdom
/** The canvas tab shows reading, failure, empty, and drawn states, and its notices keep the document visible. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import { CanvasBody, type CanvasBodyProps } from '../src/client/CanvasBody.tsx'
import { CanvasTitle } from '../src/client/CanvasTitle.tsx'
import type { CanvasState } from '../src/client/canvas-source.ts'
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

function mount(initial: Partial<CanvasState>, extra: Record<string, unknown> = {}) {
  const state = createSnapshotStore<CanvasState>({
    status: 'loading', view: undefined, error: undefined, notice: undefined, conflict: false, ...initial,
  })
  const load = vi.fn(async () => {}), edit = vi.fn(async () => {}), dismiss = vi.fn(), readFile = vi.fn()
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
  expect(props).toMatchObject({ document: filled, readFile: h.readFile, t: h.t, edit: h.edit, reload: h.load })
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
const boardView = { ...view, document: boardDoc, segments: { b1: [] } }

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
  act(() => { flow.onSelect('b1') })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'inspector.openTable' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.openTable' }))
  expect(screen.getByRole('button', { name: 'table.addRow' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'canvas.export' })).toBeNull()
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
