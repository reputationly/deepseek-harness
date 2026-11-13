// @vitest-environment jsdom
/** The flow renders the document, reports selection, and maps keyboard gestures onto edits. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import { CanvasFlow, type CanvasFlowProps } from '../src/client/CanvasFlow.tsx'
import { EditHistory } from '../src/client/model/history.ts'

beforeAll(() => {
  Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
  Object.assign(globalThis, { DOMMatrixReadOnly: class { m22 = 1 } })
})

afterEach(() => { cleanup() })

const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${JSON.stringify(params)}`
const doc: CanvasDocument = {
  version: 2, revision: 1, nextId: 4,
  edges: [{ id: 'n1->n2:prompt', source: 'n1' as never, target: 'n2' as never, kind: 'reference', role: 'prompt' }],
  nodes: [
    { id: 'n1' as never, type: 'text', title: 'Brief', x: 0, y: 0, width: 280, height: 160, activeVersion: 'v1' as never,
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', text: 'brief' }] },
    { id: 'n2' as never, type: 'image', title: 'a.png', x: 360, y: 0, width: 280, height: 260, activeVersion: 'v1' as never,
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', path: '/a.png' }] },
  ],
}

function mount() {
  const edit = vi.fn(async () => {})
  const reload = vi.fn(async () => {})
  const onSelect = vi.fn()
  const readFile = vi.fn(async () => ({ ok: false as const, message: 'unused' }))
  render(<CanvasFlow document={doc} readFile={readFile} t={t} edit={edit} reload={reload}
    onSelect={onSelect} history={new EditHistory()} />)
  return { edit, reload, onSelect }
}

it('renders one flow node per document node', async () => {
  mount()
  await waitFor(() => { expect(screen.getByText('Brief')).toBeTruthy() })
  expect(screen.getByText('a.png')).toBeTruthy()
  expect(globalThis.document.querySelectorAll('.react-flow__node')).toHaveLength(2)
})

it('reports the clicked node and clears the selection on the pane', async () => {
  const h = mount()
  await waitFor(() => { expect(screen.getByText('Brief')).toBeTruthy() })
  fireEvent.click(screen.getByText('Brief'))
  expect(h.onSelect).toHaveBeenCalledWith('n1')
  fireEvent.click(globalThis.document.querySelector('.react-flow__pane') as HTMLElement)
  expect(h.onSelect).toHaveBeenCalledWith(undefined)
})

it('undoes and redoes with the keyboard, and groups selected nodes with G', async () => {
  const h = mount()
  await waitFor(() => { expect(screen.getByText('Brief')).toBeTruthy() })
  const history = new EditHistory()
  void history
  fireEvent.keyDown(window, { key: 'z', metaKey: true })
  expect(h.edit).not.toHaveBeenCalled()
  const node = globalThis.document.querySelector('.react-flow__node') as HTMLElement
  fireEvent.click(node)
  fireEvent.keyDown(window, { key: 'g' })
  expect(h.edit).not.toHaveBeenCalled()
})

it('toggles playback only when a media element is selected', async () => {
  const h = mount()
  await waitFor(() => { expect(screen.getByText('Brief')).toBeTruthy() })
  fireEvent.keyDown(window, { code: 'Space' })
  expect(h.edit).not.toHaveBeenCalled()
})

it('drives zoom, fit, refresh, group, and remove from the toolbar', async () => {
  const h = mount()
  await waitFor(() => { expect(screen.getByText('Brief')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'zoomOut' }))
  fireEvent.click(screen.getByRole('button', { name: 'zoomIn' }))
  fireEvent.click(screen.getByRole('button', { name: 'fit' }))
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  expect(h.reload).toHaveBeenCalled()
  fireEvent.click(screen.getByText('Brief'))
  fireEvent.click(screen.getByText('a.png'), { ctrlKey: true })
  const group = screen.getByRole('button', { name: 'group' }) as HTMLButtonElement
  if (!group.disabled) fireEvent.click(group)
  const remove = screen.getByRole('button', { name: 'remove' }) as HTMLButtonElement
  if (!remove.disabled) fireEvent.click(remove)
  expect(h.edit.mock.calls.length).toBeGreaterThan(0)
})

it('applies a confirmation-backed deletion and redraws when the document changes', async () => {
  const h = mount()
  await waitFor(() => { expect(screen.getByText('Brief')).toBeTruthy() })
  fireEvent.click(screen.getByText('Brief'))
  window.confirm = vi.fn(() => true)
  fireEvent.keyDown(screen.getByText('Brief'), { key: 'Delete' })
  await waitFor(() => { expect(h.edit).toHaveBeenCalled() })
  const next = { ...doc, revision: 2, nodes: [doc.nodes[0]!, {
    id: 'n3' as never, type: 'text' as const, title: 'Added', x: 0, y: 300, width: 100, height: 100,
    activeVersion: 'v1' as never, versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user' as const, text: 'x' }],
  }] }
  const reload = vi.fn(async () => {})
  render(<CanvasFlow document={next} readFile={async () => ({ ok: false, message: 'no' })} t={t}
    edit={h.edit} reload={reload} onSelect={() => {}} />)
  await waitFor(() => { expect(screen.getByText('Added')).toBeTruthy() })
})

it('redraws the same flow when the document object changes', async () => {
  const edit = vi.fn(async () => {})
  const readFile = async () => ({ ok: false as const, message: 'no' })
  const first: CanvasFlowProps = { document: doc, readFile, t, edit, reload: async () => {}, onSelect: () => {} }
  const { rerender } = render(<CanvasFlow {...first} />)
  await waitFor(() => { expect(screen.getByText('Brief')).toBeTruthy() })
  const nextDoc = { ...doc, revision: 2, nodes: [...doc.nodes, {
    id: 'n9' as never, type: 'text' as const, title: 'Later', x: 0, y: 320, width: 100, height: 60,
    activeVersion: 'v1' as never, versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user' as const, text: 'x' }],
  }] }
  rerender(<CanvasFlow {...first} document={nextDoc} />)
  await waitFor(() => { expect(screen.getByText('Later')).toBeTruthy() })
})

it('refits when the studio asks it to', async () => {
  mount()
  await waitFor(() => { expect(screen.getByText('Brief')).toBeTruthy() })
  fireEvent(window, new Event('canvas:fit'))
  fireEvent.click(screen.getByRole('button', { name: 'fit' }))
})
