// @vitest-environment jsdom
/** The storyboard table edits cells, rows, and shows the live segmentation. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasNode, CanvasOperation, Shot } from '@deepseek-ai/dsh-canvas/client'
import { StoryboardTable } from '../src/client/StoryboardTable.tsx'

afterEach(() => { cleanup() })

const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${JSON.stringify(params)}`

const shot = (id: string, extra: Partial<Shot> = {}): Shot => ({
  id: id as never, title: id, shotSize: 'medium', visual: `画面 ${id}`, motion: '动作', camera: '固定', durationSec: 3,
  characters: [], props: [], dialogue: [], sfx: '雨', negative: '', ...extra,
})

const node: CanvasNode = {
  id: 'b1' as never, type: 'storyboard', title: '场1 分镜', x: 0, y: 0, width: 320, height: 200,
  activeVersion: 'v1' as never,
  versions: [{
    id: 'v1' as never, createdAt: 'now', origin: 'user',
    shots: [shot('s1'), shot('s2', { shotSize: 'close', durationSec: 4, dialogue: [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: '旧台词' }] }), shot('s3')],
  }],
}

function mount() {
  const edit = vi.fn<(operations: readonly CanvasOperation[]) => Promise<void>>(async () => {})
  const close = vi.fn()
  render(<StoryboardTable node={node} edit={edit} close={close} t={t} />)
  return { edit, close }
}

it('renders every row with its fields, dialogue, and the segmentation summary', () => {
  mount()
  expect(screen.getByLabelText('table.title')).toBeTruthy()
  expect(screen.getAllByRole('row')).toHaveLength(4)
  expect((screen.getAllByRole('spinbutton')[1] as HTMLInputElement).value).toBe('4')
  expect((screen.getAllByRole('textbox')[0] as HTMLTextAreaElement).value).toBe('画面 s1')
  expect(screen.getByText(/storyboard.summary/)).toBeTruthy()
})

it('sends a shot update for a changed cell and a duration below one second is raised', () => {
  const h = mount()
  const firstRow = screen.getAllByRole('row')[1] as HTMLElement
  fireEvent.change(within(firstRow).getByRole('combobox'), { target: { value: 'wide' } })
  expect(h.edit).toHaveBeenCalledWith([{ op: 'update_shot', node: 'b1', shot: 's1', patch: { shotSize: 'wide' } }])
  const duration = within(firstRow).getByRole('spinbutton') as HTMLInputElement
  fireEvent.change(duration, { target: { value: '0.2' } })
  const operations = h.edit.mock.calls.flatMap(call => call[0])
  expect(operations).toEqual(expect.arrayContaining([
    { op: 'update_shot', node: 'b1', shot: 's1', patch: { durationSec: 1 } },
  ]))
})

it('edits the dialogue of one shot as lines', () => {
  const h = mount()
  const dialogue = screen.getAllByRole('textbox').filter(element => element.tagName === 'TEXTAREA')
  fireEvent.blur(dialogue[3] as HTMLElement, { target: { value: '新台词一\n新台词二' } })
  expect(h.edit).toHaveBeenCalledWith([{
    op: 'update_shot', node: 'b1', shot: 's2',
    patch: { dialogue: [
      { id: 'd1', speaker: { kind: 'narrator' }, line: '新台词一' },
      { id: 'd2', speaker: { kind: 'narrator' }, line: '新台词二' },
    ] },
  }])
})

it('adds, removes, and reorders rows', () => {
  const h = mount()
  fireEvent.click(screen.getByRole('button', { name: 'table.addRow' }))
  expect(h.edit).toHaveBeenCalledWith([expect.objectContaining({ op: 'insert_shot' })])
  fireEvent.click(screen.getAllByRole('button', { name: 'table.removeRow' })[1] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'remove_shot', node: 'b1', shot: 's2' }])
  const rows = screen.getAllByRole('row').slice(1)
  fireEvent.dragStart(rows[2] as HTMLElement)
  fireEvent.dragOver(rows[0] as HTMLElement)
  fireEvent.drop(rows[0] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'move_shot', node: 'b1', shot: 's3' }])
})
