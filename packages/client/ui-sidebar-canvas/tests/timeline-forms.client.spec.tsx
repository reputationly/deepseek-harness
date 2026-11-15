// @vitest-environment jsdom
/** Revision conflicts and unconfirmed writes leave the editing draft reviewable. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CanvasDocument,
  CanvasNodeId,
  Timeline,
  TimelineClip,
  TimelineClipId,
  TimelineOperation,
  TimelineTrackId,
  VersionId,
} from '@deepseek-ai/dsh-canvas/client'
import type { NS } from '../src/client/locales.ts'
import { TimelineClipForm, type TimelineClipFormProps } from '../src/client/TimelineClipForm.tsx'
import { TimelineHistory } from '../src/client/TimelineHistory.tsx'
import { emptyTimelineState } from '../src/client/timeline-source.ts'
import { TimelineLibrary } from '../src/client/TimelineSetup.tsx'

afterEach(cleanup)
const t: PropsLocale<typeof NS>['t'] = key => key
const spec: Timeline['spec'] = { width: 1280, height: 720, fps: 24 }
const clip: TimelineClip = {
  id: brandString<TimelineClipId>('k1'),
  startMs: 0,
  durationMs: 2000,
  text: { content: 'original', position: 'bottom', size: 36, color: '#ffffff' },
}

it('inserts an unadopted upload candidate by its exact retained version without adopting it', async () => {
  const adopted = brandString<VersionId>('v1'),
    candidate = brandString<VersionId>('v_import'),
    source = brandString<CanvasNodeId>('n1'),
    track = brandString<TimelineTrackId>('video')
  const document: Timeline = {
    version: 1,
    revision: 1,
    spec,
    tracks: [{ id: track, kind: 'video', muted: false, volume: 1, clips: [] }],
  }
  const canvas: CanvasDocument = {
    version: 3,
    revision: 2,
    nextId: 2,
    edges: [],
    nodes: [
      {
        id: source,
        type: 'video',
        title: 'Shot',
        x: 0,
        y: 0,
        width: 320,
        height: 220,
        activeVersion: adopted,
        versions: [
          { id: adopted, path: '/old.mp4', createdAt: 'before', origin: 'user' },
          { id: candidate, path: '/upload.mp4', durationMs: 1000, createdAt: 'now', origin: 'user' },
        ],
      },
    ],
  }
  const apply = vi.fn(async () => true)
  render(
    <TimelineLibrary
      document={document}
      canvas={canvas}
      selectedTrack={track}
      playhead={0}
      disabled={false}
      apply={apply}
      draftChanged={vi.fn()}
      discard={vi.fn()}
      t={t}
    />,
  )
  const select = screen.getByLabelText<HTMLSelectElement>('editor.source')
  fireEvent.change(select, { target: { value: `${source}/${candidate}` } })
  fireEvent.submit(select.form!)
  await waitFor(() => {
    const expectedClip1: unknown = expect.objectContaining({ source: { node: source, version: candidate, inMs: 0 }, durationMs: 1000 })
    expect(apply).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          op: 'add_clip',
          track,
          clip: expectedClip1,
        }),
      ],
      1,
    )
  })
  expect(canvas.nodes[0]!.activeVersion).toBe(adopted)
})
function fixture() {
  return {
    clip,
    spec,
    revision: 1,
    image: false,
    removed: false,
    disabled: false,
    t,
    apply: vi.fn<TimelineClipFormProps['apply']>(async () => false),
    draftChanged: vi.fn(),
    discard: vi.fn(),
  }
}

it('keeps user text through a reread and merges only changed fields into the reviewed newer revision', async () => {
  const props = fixture()
  const view = render(<TimelineClipForm {...props} />)
  fireEvent.change(screen.getByLabelText('editor.subtitle'), { target: { value: '我的字幕' } })
  const updated: TimelineClip = {
    ...clip,
    text: { content: 'Agent text', position: 'top', size: 40, color: '#0000ff' },
  }
  view.rerender(<TimelineClipForm {...props} clip={updated} revision={2} />)
  expect(screen.getByLabelText<HTMLTextAreaElement>('editor.subtitle').value).toBe('我的字幕')
  expect(screen.getByLabelText<HTMLInputElement>('editor.color').value).toBe('#0000ff')
  expect(props.apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'editor.apply' }))
  await waitFor(() => {
    expect(props.apply).toHaveBeenCalledTimes(1)
  })
  const commands: TimelineOperation[] = [
    {
      op: 'set_clip',
      clip: clip.id,
      patch: { text: { content: '我的字幕', position: 'top', size: 40, color: '#0000ff' } },
    },
  ]
  expect(props.apply).toHaveBeenLastCalledWith(commands, 1)
  fireEvent.click(screen.getByRole('button', { name: 'editor.applyLatest' }))
  await waitFor(() => {
    expect(props.apply).toHaveBeenLastCalledWith(commands, 2)
  })
  expect(screen.getByLabelText<HTMLTextAreaElement>('editor.subtitle').value).toBe('我的字幕')
})

it('retains a removed clip draft and allows explicit discard even when current data is untrusted', () => {
  const props = fixture()
  const view = render(<TimelineClipForm {...props} />)
  fireEvent.change(screen.getByLabelText('editor.subtitle'), { target: { value: '保留的草稿' } })
  view.rerender(<TimelineClipForm {...props} removed disabled />)
  expect(screen.getByLabelText<HTMLTextAreaElement>('editor.subtitle').value).toBe('保留的草稿')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'editor.apply' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'editor.discard' }))
  expect(props.discard).toHaveBeenCalledOnce()
  expect(props.draftChanged).toHaveBeenLastCalledWith(false)
  expect(props.apply).not.toHaveBeenCalled()
})

it('does not submit invalid fade lengths or discard the form after rejection', async () => {
  const props = fixture()
  const video: TimelineClip = {
    id: clip.id,
    startMs: 0,
    durationMs: 1000,
    source: { node: brandString<CanvasNodeId>('n1'), version: brandString<VersionId>('v1'), inMs: 0 },
  }
  render(<TimelineClipForm {...props} clip={video} />)
  fireEvent.change(screen.getByLabelText('editor.fadeIn'), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'editor.apply' }))
  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toBe('editor.invalid')
  })
  expect(props.apply).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLInputElement>('editor.fadeIn').value).toBe('2')
})

it('requires explicit review before restoring a selected historical revision against a changed timeline', async () => {
  const restore = vi.fn(async (_revision: number, _baseline: number, _mode: 'restore' | 'undo' | 'redo') => false)
  const close = vi.fn()
  const document: Timeline = { version: 1, revision: 3, spec, tracks: [] }
  const state = {
    ...emptyTimelineState(),
    document,
    history: [3, 2, 1].map(revision => ({ revision, spec, tracks: 0, clips: 0, durationMs: 0 })),
  }
  render(
    <TimelineHistory
      initial={{ revision: 1, baseRevision: 2, mode: 'undo' }}
      state={state}
      disabled={false}
      close={close}
      t={t}
      actions={{ restore, readHistory: async () => undefined, load: async () => undefined }}
    />,
  )
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'editor.undo' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'editor.reviewHistory' }))
  expect(restore).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'editor.restore' }))
  await waitFor(() => {
    expect(restore).toHaveBeenCalledExactlyOnceWith(1, 3, 'restore')
  })
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLSelectElement>('editor.historyVersion').value).toBe('1')
})
