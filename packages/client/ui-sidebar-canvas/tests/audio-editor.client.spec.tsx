// @vitest-environment jsdom
/** Audio editing retains draft ownership and separates listening from adopting. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasDocument, CanvasNode, CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { AudioEditor, type AudioEditorProps } from '../src/client/AudioEditor.tsx'
import { AudioFields } from '../src/client/AudioFields.tsx'

afterEach(cleanup)

it('reports the exact auditioned candidate and unsaved-draft flag without publishing draft values', async () => {
  const reportEditor = vi.fn()
  render(<AudioEditor {...fixture()} reportEditor={reportEditor} />)
  await waitFor(() => {
    expect(reportEditor).toHaveBeenCalledWith(
      expect.objectContaining({ application: 'music', node: nodeId, version: first, dirty: false }),
    )
  })
  fireEvent.change(screen.getByLabelText('audio.style'), { target: { value: 'private unsaved style' } })
  fireEvent.change(screen.getByLabelText('inspector.versions'), { target: { value: second } })
  await waitFor(() => {
    expect(reportEditor).toHaveBeenLastCalledWith(expect.objectContaining({ version: second, dirty: true }))
  })
  expect(JSON.stringify(reportEditor.mock.calls)).not.toContain('private unsaved style')
})

it('saves local controls against the exact selected version and scope without adoption or preview changes', async () => {
  const h = fixture()
  const edited = brandString<VersionId>('edited')
  const editMedia = vi.fn(async () => ({
    ok: true as const,
    value: { node: nodeId, version: edited, path: '/edited.wav', reused: false },
  }))
  render(<AudioEditor {...h} editMedia={editMedia} />)
  fireEvent.change(screen.getByLabelText('inspector.versions'), { target: { value: second } })
  fireEvent.change(screen.getByLabelText('audio.trimStart'), { target: { value: '1.25' } })
  fireEvent.change(screen.getByLabelText('audio.trimEnd'), { target: { value: '3' } })
  fireEvent.change(screen.getByLabelText('audio.gain'), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText('audio.fadeOut'), { target: { value: '0.3' } })
  fireEvent.click(screen.getByRole('button', { name: 'audio.saveLocal' }))
  await waitFor(() => {
    expect(editMedia).toHaveBeenCalledWith({
      scope: { directory: '/project', episode: 'e1' },
      node: nodeId,
      version: second,
      operation: 'audio_edit',
      inMs: 1250,
      outMs: 3000,
      volume: 0,
      fadeInMs: 0,
      fadeOutMs: 300,
    })
  })
  await waitFor(() => {
    expect(screen.getByText('audio.localSaved')).toBeTruthy()
  })
  expect(screen.getByLabelText<HTMLSelectElement>('inspector.versions').value).toBe(second)
  expect(h.edit).not.toHaveBeenCalled()
})

it('retains local drafts through version switches and removal of the selected history version', async () => {
  const h = fixture()
  const editMedia = vi.fn(async () => undefined)
  const view = render(<AudioEditor {...h} editMedia={editMedia} />)
  fireEvent.change(screen.getByLabelText('audio.gain'), { target: { value: '0.4' } })
  fireEvent.change(screen.getByLabelText('inspector.versions'), { target: { value: second } })
  expect(screen.getByLabelText<HTMLInputElement>('audio.gain').value).toBe('1')
  fireEvent.change(screen.getByLabelText('inspector.versions'), { target: { value: first } })
  expect(screen.getByLabelText<HTMLInputElement>('audio.gain').value).toBe('0.4')
  view.rerender(
    <AudioEditor
      {...h}
      editMedia={editMedia}
      document={{ ...document, nodes: [{ ...node, versions: node.versions!.filter(item => item.id !== first) }] }}
    />,
  )
  expect(screen.getByLabelText<HTMLInputElement>('audio.gain').value).toBe('0.4')
  expect(screen.getByLabelText<HTMLInputElement>('audio.gain').matches(':disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'audio.close' }))
  expect(h.close).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'audio.discardClose' })).toBeTruthy()
})

it('preserves a local draft after an unconfirmed request and requires explicit discard to close', async () => {
  const h = fixture()
  const editMedia = vi.fn(async () => {
    throw new Error('disconnected')
  })
  render(<AudioEditor {...h} editMedia={editMedia} />)
  fireEvent.change(screen.getByLabelText('audio.gain'), { target: { value: '0.5' } })
  fireEvent.click(screen.getByRole('button', { name: 'audio.saveLocal' }))
  await waitFor(() => {
    expect(screen.getByText('audio.localUnknown')).toBeTruthy()
  })
  expect(screen.getByLabelText<HTMLInputElement>('audio.gain').value).toBe('0.5')
  fireEvent.click(screen.getByRole('button', { name: 'audio.close' }))
  expect(h.close).not.toHaveBeenCalled()
})

it('offers only basic creation when the ACE-Step catalog omits modes and retains an unavailable saved mode', () => {
  const change = vi.fn()
  render(
    <AudioFields
      model={{ id: 'ace', model: 'ace-step', operation: 'generate_music', params: [] }}
      params={{ task_type: 'cover' }}
      change={change}
      t={key => key}
    />,
  )
  const mode = screen.getByLabelText<HTMLSelectElement>('audio.task_type')
  expect(mode.value).toBe('cover')
  expect([...mode.options].map(option => [option.value, option.disabled])).toEqual([
    ['cover', true],
    ['t2m', false],
  ])
  expect(change).not.toHaveBeenCalled()
  fireEvent.change(mode, { target: { value: 't2m' } })
  expect(change).toHaveBeenCalledWith('task_type', 't2m')
})

it('offers cover and repaint only when the ACE-Step catalog declares them', () => {
  render(
    <AudioFields
      model={{
        id: 'ace',
        model: 'ace-step',
        operation: 'generate_music',
        taskTypes: ['t2m', 'cover', 'repaint'],
        params: [],
      }}
      params={{ task_type: 'repaint' }}
      change={vi.fn()}
      t={key => key}
    />,
  )
  expect(
    [...screen.getByLabelText<HTMLSelectElement>('audio.task_type').options].map(option => option.value),
  ).toEqual(['t2m', 'cover', 'repaint'])
  expect(screen.getByLabelText('audio.repainting_start')).toBeTruthy()
})

const nodeId = brandString<CanvasNodeId>('n1')
const first = brandString<VersionId>('v1'),
  second = brandString<VersionId>('v2')
const node: CanvasNode = {
  id: nodeId,
  type: 'audio',
  title: 'Song',
  x: 0,
  y: 0,
  width: 320,
  height: 220,
  activeVersion: first,
  gen: { kind: 'music', model: 'yue2', prompt: 'acoustic', params: { lyrics: 'original lyrics', seed: 0 } },
  versions: [
    {
      id: first,
      path: '/song-1.wav',
      createdAt: 'now',
      origin: 'agent',
      model: 'yue2',
      params: { abc: 'X:1\nK:C\nC4 |' },
    },
    {
      id: second,
      path: '/song-2.wav',
      createdAt: 'later',
      origin: 'agent',
      model: 'yue2',
      params: { abc: 'X:1\nK:C\nG4 |' },
    },
  ],
}
const document: CanvasDocument = { version: 3, revision: 3, nextId: 2, nodes: [node], edges: [] }
function fixture(): AudioEditorProps {
  return {
    opening: { directory: '/project', episode: brandString<EpisodeId>('e1'), document, node },
    document,
    ready: true,
    edit: vi.fn(async () => {}),
    generate: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(async () => {}),
    capabilities: vi.fn(async () => [{ id: 'yue', model: 'yue2', operation: 'generate_music', params: [] }]),
    useResource: vi.fn(() => ({ status: 'none' as const, value: undefined, failure: undefined })),
    sessionId: brandString<SessionId>('session'),
    renderFactorySlot: () => null,
    t: key => key,
  }
}

it('previews another immutable version without adopting or submitting generation', async () => {
  const props = fixture()
  render(<AudioEditor {...props} />)
  await screen.findByLabelText('audio.lyrics')
  fireEvent.change(screen.getByLabelText('inspector.versions'), { target: { value: second } })
  expect(props.edit).not.toHaveBeenCalled()
  expect(props.generate).not.toHaveBeenCalled()
  expect(props.useResource).toHaveBeenLastCalledWith(expect.stringContaining('song-2.wav'))
  fireEvent.click(screen.getByRole('button', { name: 'inspector.useVersion' }))
  await waitFor(() => {
    expect(props.edit).toHaveBeenCalledWith([{ op: 'set_version', node: nodeId, version: second }], {
      baseRevision: 3,
      scope: { directory: '/project', episode: 'e1' },
    })
  })
})

it('copies the previewed score into a new generation draft without altering the recorded version', async () => {
  const props = fixture()
  render(<AudioEditor {...props} />)
  await screen.findByLabelText('audio.abc')
  fireEvent.change(screen.getByLabelText('inspector.versions'), { target: { value: second } })
  fireEvent.click(screen.getByText('audio.score'))
  fireEvent.click(screen.getByRole('button', { name: 'audio.useScore' }))
  expect(screen.getByLabelText<HTMLTextAreaElement>('audio.abc').value).toBe('X:1\nK:C\nG4 |')
  expect(props.edit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'inspector.apply' }))
  await waitFor(() => {
    const expectedParams2: unknown = expect.objectContaining({ abc: 'X:1\nK:C\nG4 |' })
    const expectedGen1: unknown = expect.objectContaining({ params: expectedParams2 })
    expect(props.edit).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          op: 'set_gen',
          gen: expectedGen1,
        }),
      ],
      expect.objectContaining({ baseRevision: 3 }),
    )
  })
  expect(node.versions?.[0]?.params?.abc).toBe('X:1\nK:C\nC4 |')
})

it('requires another explicit choice when the previewed candidate leaves history', async () => {
  const props = fixture()
  const view = render(<AudioEditor {...props} />)
  await screen.findByLabelText('audio.lyrics')
  fireEvent.change(screen.getByLabelText('inspector.versions'), { target: { value: second } })
  view.rerender(
    <AudioEditor
      {...props}
      document={{ ...document, revision: 4, nodes: [{ ...node, versions: [node.versions![0]!] }] }}
    />,
  )
  expect(screen.getByRole('alert').textContent).toBe('audio.versionMissing')
  expect(screen.getByLabelText<HTMLSelectElement>('inspector.versions').value).toBe('')
  expect(screen.queryByRole('button', { name: 'inspector.useVersion' })).toBeNull()
  expect(props.edit).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('inspector.versions'), { target: { value: first } })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByLabelText<HTMLSelectElement>('inspector.versions').value).toBe(first)
  expect(props.edit).not.toHaveBeenCalled()
})

it('keeps listening to the first arriving candidate when later candidates arrive', async () => {
  const props = fixture()
  const { activeVersion: _active, versions: _versions, ...empty } = node
  const initial = { ...document, nodes: [empty] }
  const view = render(
    <AudioEditor {...props} opening={{ ...props.opening, document: initial, node: empty }} document={initial} />,
  )
  const { activeVersion: _selection, ...unadopted } = node
  view.rerender(
    <AudioEditor {...props} document={{ ...document, nodes: [{ ...unadopted, versions: [node.versions![0]!] }] }} />,
  )
  await waitFor(() => {
    expect(screen.getByLabelText<HTMLSelectElement>('inspector.versions').value).toBe(first)
  })
  view.rerender(<AudioEditor {...props} document={{ ...document, nodes: [unadopted] }} />)
  expect(screen.getByLabelText<HTMLSelectElement>('inspector.versions').value).toBe(first)
  expect(props.edit).not.toHaveBeenCalled()
})

it('retains edited lyrics across disconnection and requires review after a conflicting reread', async () => {
  const props = fixture()
  const view = render(<AudioEditor {...props} />)
  await screen.findByLabelText('audio.lyrics')
  fireEvent.change(screen.getByLabelText('audio.lyrics'), { target: { value: 'my retained lyrics' } })
  view.rerender(<AudioEditor {...props} document={undefined} ready={false} />)
  expect(screen.getByLabelText<HTMLTextAreaElement>('audio.lyrics').value).toBe('my retained lyrics')
  expect(screen.getByText('audio.scopeChanged')).toBeTruthy()
  const group = screen.getByLabelText('audio.lyrics').closest('fieldset')
  expect(group?.disabled).toBe(true)
  const updated: CanvasDocument = {
    ...document,
    revision: 4,
    nodes: [{ ...node, gen: { ...node.gen!, params: { lyrics: 'Agent lyrics' } } }],
  }
  view.rerender(<AudioEditor {...props} document={updated} />)
  expect(screen.getByLabelText<HTMLTextAreaElement>('audio.lyrics').value).toBe('my retained lyrics')
  expect(screen.getByText('inspector.conflict')).toBeTruthy()
  expect(props.edit).not.toHaveBeenCalled()
})

it('keeps unsaved work open until the user explicitly discards it', async () => {
  const props = fixture()
  render(<AudioEditor {...props} />)
  await screen.findByLabelText('audio.lyrics')
  fireEvent.change(screen.getByLabelText('audio.lyrics'), { target: { value: 'keep me' } })
  fireEvent.click(screen.getByRole('button', { name: 'audio.close' }))
  expect(props.close).not.toHaveBeenCalled()
  expect(screen.getByText('audio.unsaved')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'audio.discardClose' }))
  expect(props.close).toHaveBeenCalledOnce()
})

it('shows a catalog failure and prevents submitting through an unconfirmed model list', async () => {
  const props = {
    ...fixture(),
    capabilities: vi.fn(async () => {
      throw new Error('offline')
    }),
  }
  render(<AudioEditor {...props} />)
  await screen.findByText('audio.catalogFailed')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'inspector.generateNow' }).disabled).toBe(true)
  expect(props.generate).not.toHaveBeenCalled()
  expect(screen.getByText('audio.score')).toBeTruthy()
})

it('passes the opening project and episode to generation without serializing the canvas snapshot', async () => {
  const props = fixture()
  render(<AudioEditor {...props} />)
  await screen.findByLabelText('audio.lyrics')
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  expect(props.generate).toHaveBeenCalledExactlyOnceWith(nodeId, { directory: '/project', episode: 'e1' })
})
