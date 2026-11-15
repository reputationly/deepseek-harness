// @vitest-environment jsdom
/** Local video actions retain source identity and ignore superseded preview preparation. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasNode, CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasVideoFiles } from '../src/client/face.ts'
import { VideoLocalControls } from '../src/client/VideoLocalControls.tsx'

afterEach(cleanup)
const first = brandString<VersionId>('first'),
  second = brandString<VersionId>('second')
const node: CanvasNode = {
  id: brandString<CanvasNodeId>('n1'),
  type: 'video',
  title: 'Shot',
  x: 0,
  y: 0,
  width: 320,
  height: 220,
  activeVersion: first,
  versions: [
    { id: first, path: 'first.mp4', createdAt: 'now', origin: 'agent' },
    { id: second, path: 'second.mp4', createdAt: 'later', origin: 'agent' },
  ],
}

function fixture() {
  return {
    node,
    enabled: true,
    scope: { directory: '/project', episode: brandString<EpisodeId>('e1') },
    sessionId: brandString<SessionId>('s1'),
    useResource: vi.fn((_address: string) => ({ status: 'none' as const, value: undefined, failure: undefined })),
    videoPath: vi.fn(async (_node: CanvasNodeId, _version: VersionId) => ({
      ok: true as const,
      value: '/compatible.mp4',
    })),
    editMedia: vi.fn(async () => ({
      ok: true as const,
      value: {
        node: brandString<CanvasNodeId>('n2'),
        version: brandString<VersionId>('derived'),
        path: '/frame.png',
        reused: false,
      },
    })),
    reload: vi.fn(async () => {}),
    locate: vi.fn(),
    t: (key: string) => key,
  }
}

it('retries a failed candidate preview without reimporting, editing, or adopting it', async () => {
  const h = fixture()
  const importVideo = vi.fn()
  const useResource = vi.fn(() => ({
    status: 'live' as const,
    value: { absolutePath: '/project/compatible.mp4', version: 'fresh' },
    failure: undefined,
  })) as CanvasVideoFiles['useResource']
  const view = render(<VideoLocalControls {...h} useResource={useResource} importVideo={importVideo} />)
  await waitFor(() => {
    expect(view.container.querySelector('video')).not.toBeNull()
  })
  fireEvent.change(screen.getByLabelText('video.sourceVersion'), { target: { value: second } })
  await waitFor(() => {
    expect(h.videoPath).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('video')).not.toBeNull()
  })
  const failed = view.container.querySelector('video')!
  fireEvent.error(failed)
  expect(screen.getByRole('alert').textContent).toBe('video.previewFailed')
  expect(view.container.querySelector('video')).toBeNull()
  expect(h.videoPath).toHaveBeenCalledTimes(2)
  const retry = Promise.withResolvers<Awaited<ReturnType<typeof h.videoPath>>>()
  h.videoPath.mockImplementationOnce(async () => retry.promise)
  fireEvent.click(screen.getByRole('button', { name: 'video.retryPreview' }))
  await waitFor(() => {
    expect(h.videoPath).toHaveBeenLastCalledWith(node.id, second, h.scope)
  })
  expect(screen.getByRole('status').textContent).toBe('media.loading')
  expect(screen.queryByRole('button', { name: 'video.retryPreview' })).toBeNull()
  await act(async () => {
    retry.resolve({ ok: true, value: '/compatible.mp4' })
  })
  await waitFor(() => {
    expect(view.container.querySelector('video')).not.toBeNull()
  })
  expect(view.container.querySelector('video')).not.toBe(failed)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByLabelText<HTMLSelectElement>('video.sourceVersion').value).toBe(second)
  expect(node.activeVersion).toBe(first)
  expect(h.videoPath).toHaveBeenCalledTimes(3)
  expect(importVideo).not.toHaveBeenCalled()
  expect(h.editMedia).not.toHaveBeenCalled()
  expect(h.reload).not.toHaveBeenCalled()
})

it('extracts an exact candidate version in the captured project and leaves adoption alone', async () => {
  const h = fixture()
  render(<VideoLocalControls {...h} />)
  fireEvent.change(screen.getByLabelText('video.sourceVersion'), { target: { value: second } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'video.refreshTail' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'video.firstFrame' }))
  await waitFor(() => {
    expect(h.editMedia).toHaveBeenCalledWith({
      scope: h.scope,
      node: node.id,
      version: second,
      operation: 'first_frame',
      title: 'video.resultTitle',
    })
  })
  await screen.findByText('video.saved')
  expect(h.reload).toHaveBeenCalledTimes(1)
  expect(node.activeVersion).toBe(first)
  expect(screen.getByLabelText<HTMLSelectElement>('video.sourceVersion').value).toBe(second)
  fireEvent.click(screen.getByRole('button', { name: 'video.locateResult' }))
  expect(h.locate).toHaveBeenCalledWith('n2')
})

it('reports a missing explicit audition without switching the Agent hint to another version', () => {
  const h = fixture(),
    previewChanged = vi.fn()
  const view = render(<VideoLocalControls {...h} previewChanged={previewChanged} />)
  fireEvent.change(screen.getByLabelText('video.sourceVersion'), { target: { value: second } })
  expect(previewChanged).toHaveBeenLastCalledWith(node.id, second)
  view.rerender(
    <VideoLocalControls
      {...h}
      previewChanged={previewChanged}
      node={{ ...node, versions: node.versions!.filter(version => version.id !== second) }}
    />,
  )
  expect(previewChanged).toHaveBeenLastCalledWith(node.id, second)
  expect(node.activeVersion).toBe(first)
})

it('retains a missing explicit selection instead of redirecting extraction to another version', async () => {
  const h = fixture()
  const view = render(<VideoLocalControls {...h} />)
  fireEvent.change(screen.getByLabelText('video.sourceVersion'), { target: { value: second } })
  view.rerender(
    <VideoLocalControls
      {...h}
      node={{ ...node, versions: node.versions!.filter(version => version.id !== second) }}
    />,
  )
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'video.extractAudio' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'video.extractAudio' }))
  expect(h.editMedia).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLSelectElement>('video.sourceVersion').value).toBe('')
})

it('never streams a superseded preview when preparations resolve out of order', async () => {
  const h = fixture()
  let finishFirst: (value: { ok: true; value: string }) => void = () => {}
  h.videoPath
    .mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )
    .mockImplementationOnce(async () => ({ ok: true as const, value: '/second-preview.mp4' }))
  render(<VideoLocalControls {...h} />)
  fireEvent.change(screen.getByLabelText('video.sourceVersion'), { target: { value: second } })
  await waitFor(() => {
    expect(h.useResource.mock.calls.some(([address]) => address.includes('second-preview.mp4'))).toBe(true)
  })
  finishFirst({ ok: true, value: '/obsolete-preview.mp4' })
  await waitFor(() => {
    expect(h.videoPath).toHaveBeenCalledTimes(2)
  })
  expect(h.useResource.mock.calls.some(([address]) => address.includes('obsolete-preview.mp4'))).toBe(false)
})

it('uploads into the captured node without changing the adopted or auditioned version', async () => {
  const h = fixture()
  const importVideo = vi.fn(async (_node: CanvasNodeId, _scope: typeof h.scope, _file: File, _signal: AbortSignal) =>
    h.editMedia(),
  )
  render(<VideoLocalControls {...h} importVideo={importVideo} />)
  const file = new File(['media'], 'clip.mp4', { type: 'video/mp4' })
  fireEvent.change(screen.getByLabelText('video.upload'), { target: { files: [file] } })
  await screen.findByText('video.saved')
  expect(importVideo).toHaveBeenCalledWith(node.id, h.scope, file, expect.any(AbortSignal))
  expect(screen.getByLabelText<HTMLSelectElement>('video.sourceVersion').value).toBe(first)
  expect(node.activeVersion).toBe(first)
})

it('aborts the upload and ignores its late result after switching projects', async () => {
  const h = fixture()
  let finish: (value: Awaited<ReturnType<typeof h.editMedia>>) => void = () => {}
  const importVideo = vi.fn(
    async (_node: CanvasNodeId, _scope: typeof h.scope, _file: File, _signal: AbortSignal) =>
      new Promise<Awaited<ReturnType<typeof h.editMedia>>>((resolve) => {
        finish = resolve
      }),
  )
  const view = render(<VideoLocalControls {...h} importVideo={importVideo} />)
  fireEvent.change(screen.getByLabelText('video.upload'), { target: { files: [new File(['media'], 'clip.mp4')] } })
  view.rerender(
    <VideoLocalControls {...h} scope={{ ...h.scope, directory: '/other-project' }} importVideo={importVideo} />,
  )
  expect(importVideo.mock.calls[0]![3].aborted).toBe(true)
  await act(async () => {
    finish(await h.editMedia())
  })
  expect(h.reload).not.toHaveBeenCalled()
  expect(screen.queryByText('video.saved')).toBeNull()
})
