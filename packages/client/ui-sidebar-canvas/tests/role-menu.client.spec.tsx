// @vitest-environment jsdom
/** The connection menu offers the roles a pair may carry and reports the pick. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RoleMenu } from '../src/client/RoleMenu.tsx'
import { roleMenu } from '../src/client/model/edges.ts'

afterEach(() => { cleanup() })

const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${String(params.n)}`

it('renders one item per role, disables the ones already set, and reports a pick', () => {
  const onPick = vi.fn(), onClose = vi.fn()
  render(<RoleMenu x={10} y={20} choices={roleMenu('image', 'video', ['ref'])} onPick={onPick} onClose={onClose} t={t} />)
  const items = screen.getAllByRole('menuitem')
  expect(items.map(item => [item.textContent, (item as HTMLButtonElement).disabled])).toEqual([
    ['edge.ref:1 · edge.taken', true],
    ['edge.firstFrame:1', false],
    ['edge.lastFrame:1', false],
  ])
  fireEvent.click(items[1] as HTMLElement)
  expect(onPick).toHaveBeenCalledWith('first_frame')
})

it('closes on Escape and on outside click', () => {
  const onClose = vi.fn()
  const { container } = render(<RoleMenu x={0} y={0} choices={roleMenu('image', 'video', [])} onPick={() => {}} onClose={onClose} t={t} />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
  fireEvent.click(container.firstElementChild as HTMLElement)
  expect(onClose).toHaveBeenCalledTimes(2)
})

it('stays open for keys other than Escape', () => {
  const onClose = vi.fn()
  render(<RoleMenu x={0} y={0} choices={roleMenu('image', 'video', [])} onPick={() => {}} onClose={onClose} t={t} />)
  fireEvent.keyDown(window, { key: 'Enter' })
  expect(onClose).not.toHaveBeenCalled()
})
