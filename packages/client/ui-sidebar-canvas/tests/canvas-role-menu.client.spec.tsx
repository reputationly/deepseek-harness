// @vitest-environment jsdom
/** The pending-connection role menu derives its choices from the document. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import { CanvasRoleMenu } from '../src/client/CanvasRoleMenu.tsx'

afterEach(() => { cleanup() })
const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${String(params.n)}`
const doc: CanvasDocument = {
  version: 2, revision: 1, nextId: 3, edges: [{
    id: 'a->b:ref', source: 'a' as never, target: 'b' as never, kind: 'reference', role: 'ref',
  }],
  nodes: [
    { id: 'a' as never, type: 'image', title: 'a', x: 0, y: 0, width: 1, height: 1 },
    { id: 'b' as never, type: 'video', title: 'b', x: 0, y: 0, width: 1, height: 1 },
  ],
}

it('offers the free roles of the pending pair and reports the picked one', () => {
  const onPick = vi.fn(), onClose = vi.fn()
  render(<CanvasRoleMenu document={doc} menu={{ x: 5, y: 6, source: 'a', target: 'b' }} onPick={onPick} onClose={onClose} t={t} />)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    'edge.ref:1 · edge.taken', 'edge.firstFrame:1', 'edge.lastFrame:1',
  ])
  fireEvent.click(screen.getAllByRole('menuitem')[1] as HTMLElement)
  expect(onPick).toHaveBeenCalledWith('first_frame')
})

it('renders nothing while no connection waits', () => {
  const { container } = render(<CanvasRoleMenu document={doc} menu={undefined} onPick={() => {}} onClose={() => {}} t={t} />)
  expect(container.firstElementChild).toBeNull()
})

it('falls back to text for unknown nodes and ignores edges without a role', () => {
  const doc2 = { ...doc, edges: [...doc.edges, { id: 'a->b:x', source: 'a' as never, target: 'b' as never, kind: 'reference' as const }] }
  render(<CanvasRoleMenu document={doc2} menu={{ x: 0, y: 0, source: 'zz', target: 'yy' }} onPick={() => {}} onClose={() => {}} t={t} />)
  expect(screen.queryAllByRole('menuitem')).toEqual([])
})

it('falls back only for the node the document lacks', () => {
  render(<CanvasRoleMenu document={doc} menu={{ x: 0, y: 0, source: 'a', target: 'zz' }} onPick={() => {}} onClose={() => {}} t={t} />)
  expect(screen.queryAllByRole('menuitem')).toEqual([])
})

it('falls back for a missing source node', () => {
  render(<CanvasRoleMenu document={doc} menu={{ x: 0, y: 0, source: 'zz', target: 'b' }} onPick={() => {}} onClose={() => {}} t={t} />)
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
})

it('falls back for both unknown ends of a connection', () => {
  render(<CanvasRoleMenu document={doc} menu={{ x: 0, y: 0, source: 'zz', target: 'yy' }} onPick={() => {}} onClose={() => {}} t={t} />)
  expect(screen.queryAllByRole('menuitem')).toEqual([])
})

it('ignores a plain edge without a role when deriving taken roles', () => {
  const plain = { ...doc, edges: [{ id: 'a->b:x', source: 'a' as never, target: 'b' as never, kind: 'reference' as const }] }
  render(<CanvasRoleMenu document={plain} menu={{ x: 0, y: 0, source: 'a', target: 'b' }} onPick={() => {}} onClose={() => {}} t={t} />)
  expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0)
})
