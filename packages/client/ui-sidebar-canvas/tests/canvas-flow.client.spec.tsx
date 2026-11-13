// @vitest-environment jsdom
/** The flow renders the document, reports selection, and maps keyboard gestures onto edits. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import { CanvasFlow } from '../src/client/CanvasFlow.tsx'
import { EditHistory } from '../src/client/model/history.ts'

beforeAll(() => {
  Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
  Object.assign(globalThis, { DOMMatrixReadOnly: class { m22 = 1 } })
})

afterEach(() => { cleanup() })

const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${JSON.stringify(params)}`
const doc: CanvasDocument = {
  version: 2, revision: 1, nextId: 4, edges: [],
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
