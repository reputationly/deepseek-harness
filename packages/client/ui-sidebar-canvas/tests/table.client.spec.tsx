// @vitest-environment jsdom
/** The storyboard table edits cells, rows, and shows the live segmentation. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasNode, CanvasOperation, Shot, StoryboardSegment, VersionId } from '@deepseek-ai/dsh-canvas/client'
import { StoryboardTable } from '../src/client/StoryboardTable.tsx'
import type { StoryboardTableProps } from '../src/client/StoryboardTable.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${JSON.stringify(params)}`
const localeT = (messages: Readonly<Record<string, string>>): StoryboardTableProps['t'] => (key, params) => {
  const template = messages[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (placeholder, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
  })
}

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

it.each([
  {
    label: 'Chinese singular counts', t: localeT(zh), count: 1,
    expected: '共 1 镜 · 1 秒 · 1 段 · 1 次视频调用',
  },
  {
    label: 'Chinese plural counts', t: localeT(zh), count: 2,
    expected: '共 2 镜 · 2 秒 · 2 段 · 2 次视频调用',
  },
  {
    label: 'English singular counts', t: localeT(en), count: 1,
    expected: '1 shot · 1 second · 1 segment · 1 video call',
  },
  {
    label: 'English plural counts', t: localeT(en), count: 2,
    expected: '2 shots · 2 seconds · 2 segments · 2 video calls',
  },
])('localizes the storyboard footer with $label', ({ count, expected, t }) => {
  const versionId = brandString<VersionId>('summary-version')
  const shots = Array.from({ length: count }, (_value, index) => shot(`summary-${String(index + 1)}`, { durationSec: 1 }))
  const segments: StoryboardSegment[] = shots.map((current, index) => ({
    index, shots: [current.id], durationSec: current.durationSec, kind: 'opening', join: 'strict', needsTailChain: false,
  }))
  const summaryNode: CanvasNode = {
    ...node, activeVersion: versionId,
    versions: [{ id: versionId, createdAt: 'now', origin: 'user', shots }],
  }
  render(<StoryboardTable node={summaryNode} edit={async () => {}} close={() => {}} t={t} segments={segments} />)
  expect(screen.getByText(expected)).toBeTruthy()
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
  expect(h.edit).toHaveBeenCalledWith([
    { op: 'move_shot', node: 'b1', shot: 's3', after: 's1' },
    { op: 'move_shot', node: 'b1', shot: 's1', after: 's3' },
  ])
})

it('edits the text cells, ignores a drop without a drag, and switches back to the bible tab', () => {
  const h = mount()
  const rows = screen.getAllByRole('row').slice(1)
  const cells = within(rows[0] as HTMLElement).getAllByRole('textbox')
  fireEvent.blur(cells[0] as HTMLElement, { target: { value: '新画面' } })
  fireEvent.blur(within(rows[0] as HTMLElement).getAllByRole('textbox')[1] as HTMLElement, { target: { value: '新动作' } })
  const inputs = within(rows[0] as HTMLElement).getAllByRole('textbox')
  fireEvent.blur(inputs[0] as HTMLElement, { target: { value: '新运镜' } })
  const sound = within(rows[0] as HTMLElement).getAllByRole('textbox').at(-2) as HTMLElement
  fireEvent.blur(sound, { target: { value: '新音效' } })
  const negative = within(rows[0] as HTMLElement).getAllByRole('textbox').at(-1) as HTMLElement
  fireEvent.blur(negative, { target: { value: '新负向' } })
  fireEvent.drop(rows[0] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'update_shot', node: 'b1', shot: 's1', patch: { visual: '新画面' } }])
  expect(h.edit).toHaveBeenCalledWith([{ op: 'update_shot', node: 'b1', shot: 's1', patch: { negative: '新负向' } }])
})

it('edits the camera cell', () => {
  const h = mount()
  const row = screen.getAllByRole('row')[1] as HTMLElement
  const camera = within(row).getAllByRole('textbox')[2] as HTMLElement
  fireEvent.blur(camera, { target: { value: '手持跟拍' } })
  expect(h.edit).toHaveBeenCalledWith([{ op: 'update_shot', node: 'b1', shot: 's1', patch: { camera: '手持跟拍' } }])
})

it('drops a later row onto an earlier one after the first row', () => {
  const h = mount()
  const rows = screen.getAllByRole('row').slice(1)
  fireEvent.dragStart(rows[2] as HTMLElement)
  fireEvent.dragOver(rows[1] as HTMLElement)
  fireEvent.drop(rows[1] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'move_shot', node: 'b1', shot: 's3', after: 's1' }])
})
