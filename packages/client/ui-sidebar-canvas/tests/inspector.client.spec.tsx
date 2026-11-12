// @vitest-environment jsdom
/** The inspector renders catalog controls, reorders references, and turns edits into canvas operations. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasDocument, CanvasNode } from '@deepseek-ai/dsh-canvas/client'
import { Inspector, type InspectorProps } from '../src/client/Inspector.tsx'

afterEach(() => { cleanup() })

const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${JSON.stringify(params)}`

const video: CanvasNode = {
  id: 'v1' as never, type: 'video', title: '场1 段1', x: 0, y: 0, width: 320, height: 220,
  activeVersion: 'v2' as never,
  versions: [
    { id: 'v1' as never, createdAt: 'now', origin: 'user', path: '/a.mp4', model: 'old' },
    { id: 'v2' as never, createdAt: 'now', origin: 'agent', path: '/b.mp4', model: 'new' },
  ],
  gen: { kind: 'video', prompt: '雨夜', model: 'video-model', params: { duration: 6 } },
}

const document: CanvasDocument = {
  version: 2, revision: 1, nextId: 5, edges: [
    { id: 'a->v1:ref', source: 'a' as never, target: 'v1' as never, kind: 'reference', role: 'ref', order: 0 },
    { id: 'b->v1:ref', source: 'b' as never, target: 'v1' as never, kind: 'reference', role: 'ref', order: 1 },
    { id: 'f->v1:first_frame', source: 'f' as never, target: 'v1' as never, kind: 'reference', role: 'first_frame' },
  ],
  nodes: [
    video,
    { id: 'a' as never, type: 'image', title: '林夏', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b' as never, type: 'image', title: '场景', x: 0, y: 0, width: 100, height: 100 },
    { id: 'f' as never, type: 'image', title: '首帧图', x: 0, y: 0, width: 100, height: 100 },
  ],
}

const capabilities = vi.fn(async () => [{
  id: 'cap', model: 'video-model', operation: 'generate_video',
  params: [
    { id: 'duration', options: ['5', '10'], default: '5' },
    { id: 'resolution', options: ['2K'], default: '2K' },
  ],
}])

function mount(overrides: Partial<InspectorProps> = {}) {
  const edit = vi.fn(async () => {})
  const close = vi.fn()
  render(<Inspector document={document} node={video} placement="sidebar" capabilities={capabilities}
    edit={edit} close={close} t={t} {...overrides} />)
  return { edit, close }
}

it('lists the model, its catalog parameters, and the node prompt', async () => {
  mount()
  await waitFor(() => { expect(capabilities).toHaveBeenCalledWith('generate_video') })
  expect((screen.getByLabelText('inspector.model') as HTMLSelectElement).value).toBe('video-model')
  const duration = screen.getByLabelText('duration') as HTMLSelectElement
  expect(duration.value).toBe('6')
  expect((screen.getByLabelText('resolution') as HTMLSelectElement).value).toBe('2K')
  expect((screen.getByLabelText('inspector.prompt') as HTMLTextAreaElement).value).toBe('雨夜')
})

it('applies model, prompt, and numeric parameters as one generation update', async () => {
  const h = mount()
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.change(screen.getByLabelText('duration'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('inspector.prompt'), { target: { value: '新提示' } })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.apply' }))
  expect(h.edit).toHaveBeenCalledWith([{
    op: 'set_gen', node: 'v1', gen: { model: 'video-model', prompt: '新提示', params: { duration: 10 } },
  }])
})

it('reorders references by drag and removes one', async () => {
  const h = mount()
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  const rows = screen.getAllByRole('listitem').filter(row => row.textContent?.includes('林夏') || row.textContent?.includes('场景'))
  fireEvent.dragStart(rows[0] as HTMLElement)
  fireEvent.dragOver(rows[1] as HTMLElement)
  fireEvent.drop(rows[1] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'reorder_refs', node: 'v1', sources: ['b', 'a'] }])
  fireEvent.click(screen.getAllByRole('button', { name: 'inspector.removeReference' })[0] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'disconnect', from: 'a', to: 'v1', role: 'ref' }])
})

it('clears a frame slot and switches the shown version', async () => {
  const h = mount()
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.clearFrame' }))
  expect(h.edit).toHaveBeenCalledWith([{ op: 'disconnect', from: 'f', to: 'v1', role: 'first_frame' }])
  fireEvent.click(screen.getAllByRole('button', { name: 'inspector.useVersion' })[0] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'set_version', node: 'v1', version: 'v1' }])
})

it('closes through its header button and opens the table editor for a storyboard', async () => {
  const openTable = vi.fn()
  const { gen: _gen, ...rest } = video
  void _gen
  const h = mount({ node: { ...rest, type: 'storyboard' }, openTable })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'inspector.close' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.close' }))
  expect(h.close).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'inspector.openTable' }))
  expect(openTable).toHaveBeenCalledWith('v1')
})

it('asks for the budget and starts generation once the user confirms', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'needs_confirmation' as const, token: 'tok', lines: [{ node: 'v1', kind: 'video', model: 'video-model', calls: 2, seconds: 12 }],
    totals: { videoCalls: 2, videoSeconds: 12, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn(async () => ({
    state: 'started' as const, lines: [], totals: { videoCalls: 2, videoSeconds: 12, imageCalls: 0, speechLines: 0, musicCalls: 0 },
    jobs: [{ node: 'v1', jobId: 'j1' }],
  }))
  mount({ planNodes, generateNodes })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('dialog', { name: 'budget.title' })).toBeTruthy() })
  expect(screen.getByText(/budget.totals/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'budget.confirm' }))
  await waitFor(() => { expect(generateNodes).toHaveBeenCalledWith(['v1'], 'tok') })
  expect(screen.getByRole('status').textContent).toContain('inspector.started')
})

it('starts a plan that needs no confirmation directly', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'ready' as const, lines: [], totals: { videoCalls: 1, videoSeconds: 5, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn(async () => ({
    state: 'started' as const, lines: [], totals: { videoCalls: 1, videoSeconds: 5, imageCalls: 0, speechLines: 0, musicCalls: 0 },
    jobs: [{ node: 'v1', jobId: 'j1' }],
  }))
  mount({ planNodes, generateNodes })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(generateNodes).toHaveBeenCalledWith(['v1'], undefined) })
  expect(screen.queryByRole('dialog')).toBeNull()
})
