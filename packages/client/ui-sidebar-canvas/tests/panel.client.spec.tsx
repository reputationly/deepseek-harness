// @vitest-environment jsdom
/** The bible and asset panel lists entries, makes a three-view node, and filters assets. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bible, CanvasDocument } from '@deepseek-ai/dsh-canvas/client'
import { BibleAssetsPanel } from '../src/client/BibleAssetsPanel.tsx'
import type { CanvasSource } from '../src/client/canvas-source.ts'

afterEach(() => { cleanup() })

const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${JSON.stringify(params)}`
const bible: Bible = {
  version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' },
  entries: [
    { id: 'c1' as never, kind: 'character', name: '林夏', aliases: [], description: '夜班店员', imageNodes: [] },
    { id: 'l1' as never, kind: 'location', name: '便利店', aliases: [], description: '雨夜街角', imageNodes: [] },
  ],
  narrator: {},
}
const document: CanvasDocument = {
  version: 3, revision: 1, nextId: 5, edges: [],
  nodes: [
    { id: 'n1' as never, type: 'image', title: '参考图', x: 0, y: 0, width: 1, height: 1 },
    { id: 'n2' as never, type: 'video', title: '段1', x: 0, y: 0, width: 1, height: 1 },
    { id: 'n3' as never, type: 'text', title: '说明', x: 0, y: 0, width: 1, height: 1 },
  ],
}

it('lists the bible by kind, creates a three-view image, then starts its generation', async () => {
  const generate = vi.fn()
  const edit = vi.fn<CanvasSource['edit']>(async (operations, options) => {
    options?.onApplied?.(document, operations, { revision: 2, refs: { 'three-view': 'n4' as never }, created: ['n4' as never], skipped: [] })
  })
  render(<BibleAssetsPanel document={document} bible={bible} edit={edit} generate={generate} select={() => {}} close={() => {}} t={t} />)
  expect(screen.getByText('林夏')).toBeTruthy()
  expect(screen.getByText('便利店')).toBeTruthy()
  fireEvent.click(screen.getAllByRole('button', { name: 'bible.threeView' })[0] as HTMLElement)
  expect(edit).toHaveBeenCalledOnce()
  expect(edit.mock.calls[0]?.[0]).toMatchObject([{
    op: 'add', type: 'image', bible: 'c1', title: '林夏 bible.threeView',
    gen: { kind: 'image' },
  }])
  expect(edit.mock.calls[0]?.[1]?.onApplied).toBeTypeOf('function')
  await waitFor(() => { expect(generate).toHaveBeenCalledExactlyOnceWith('n4') })
})

it('filters assets by type and selects one', () => {
  const select = vi.fn()
  render(<BibleAssetsPanel document={document} bible={bible} edit={async () => {}} select={select} close={() => {}} t={t} />)
  fireEvent.click(screen.getByRole('tab', { name: 'assets.tab' }))
  expect(screen.getByRole('button', { name: '参考图' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '说明' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'assets.kind.video' }))
  expect(screen.queryByRole('button', { name: '参考图' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '段1' }))
  expect(select).toHaveBeenCalledWith('n2')
})

it.each([false, true])('does not start generation when image creation is refused (throws: %s)', async (throws) => {
  const generate = vi.fn()
  render(<BibleAssetsPanel document={document} bible={bible} edit={async () => {
    if (throws) throw new Error('storage unavailable')
  }} generate={generate} select={() => {}} close={() => {}} t={t} />)
  fireEvent.click(screen.getAllByRole('button', { name: 'bible.threeView' })[0]!)
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('bible.threeViewFailed') })
  expect(generate).not.toHaveBeenCalled()
})

it('switches back to the bible tab', () => {
  render(<BibleAssetsPanel document={document} bible={bible} edit={async () => {}} select={() => {}} close={() => {}} t={t} />)
  fireEvent.click(screen.getByRole('tab', { name: 'assets.tab' }))
  fireEvent.click(screen.getByRole('tab', { name: 'bible.tab' }))
  expect(screen.getByText('林夏')).toBeTruthy()
})

it('shows empty groups and an empty asset filter', () => {
  render(<BibleAssetsPanel document={document} bible={{ ...bible, entries: [] }} edit={async () => {}}
    select={() => {}} close={() => {}} t={t} />)
  expect(screen.getAllByText('bible.empty')).toHaveLength(3)
  fireEvent.click(screen.getByRole('tab', { name: 'assets.tab' }))
  fireEvent.click(screen.getByRole('button', { name: 'assets.kind.audio' }))
  expect(screen.getByText('assets.empty')).toBeTruthy()
})
