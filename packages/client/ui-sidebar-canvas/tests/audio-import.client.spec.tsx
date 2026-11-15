// @vitest-environment jsdom
/** Local uploads preserve the captured target and discard late publication after an app switch. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { RemoteResult, LocalMediaEditResult } from '@deepseek-ai/dsh-api-remotes/client'
import { AudioImportControls, type AudioImportControlsProps } from '../src/client/AudioImportControls.tsx'

afterEach(cleanup)
const node = brandString<CanvasNodeId>('n1')
const scope = { directory: '/project', episode: brandString<EpisodeId>('e1') }
const t = (key: string) => key
const result: RemoteResult<LocalMediaEditResult> = { ok: true, value: { node, version: brandString<VersionId>('v1'), path: '/project/import.wav', reused: false } }
const file = new File(['existing audio'], 'music.wav', { type: 'audio/wav' })

it('uploads the first local audio through its captured scope and reports a saved candidate', async () => {
  const upload = vi.fn(async () => result), reload = vi.fn(async () => {})
  render(<AudioImportControls node={node} scope={scope} enabled upload={upload} reload={reload} t={t} />)
  fireEvent.change(screen.getByLabelText('audio.upload'), { target: { files: [file] } })
  await screen.findByText('audio.uploaded')
  expect(upload).toHaveBeenCalledExactlyOnceWith(node, scope, file, expect.any(AbortSignal))
  expect(reload).toHaveBeenCalledOnce()
})

it('cancels an unavailable target and ignores its late upload result', async () => {
  let settle!: (reply: RemoteResult<LocalMediaEditResult>) => void
  const upload = vi.fn<AudioImportControlsProps['upload']>(() => new Promise<RemoteResult<LocalMediaEditResult>>((resolve) => { settle = resolve }))
  const reload = vi.fn(async () => {})
  const props = { node, scope, enabled: true, upload, reload, t }
  const view = render(<AudioImportControls {...props} />)
  fireEvent.change(screen.getByLabelText('audio.upload'), { target: { files: [file] } })
  expect(screen.getByText('audio.uploading')).toBeTruthy()
  const signal = upload.mock.calls[0]?.[3]
  view.rerender(<AudioImportControls {...props} enabled={false} />)
  expect(signal?.aborted).toBe(true)
  settle(result)
  await waitFor(() => { expect(screen.queryByText('audio.uploading')).toBeNull() })
  expect(reload).not.toHaveBeenCalled()
  expect(screen.queryByText('audio.uploaded')).toBeNull()
})

it('distinguishes an acknowledged candidate from a failed refresh', async () => {
  render(<AudioImportControls node={node} scope={scope} enabled upload={async () => result} reload={async () => { throw new Error('offline') }} t={t} />)
  fireEvent.change(screen.getByLabelText('audio.upload'), { target: { files: [file] } })
  await screen.findByText('audio.localRefreshFailed')
  expect(screen.queryByText('audio.localUnknown')).toBeNull()
})
