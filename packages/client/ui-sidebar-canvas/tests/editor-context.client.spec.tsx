// @vitest-environment jsdom
/** Selection publication failures stay visible and can be retried without changing project data. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasEditorContext, EpisodeId } from '@deepseek-ai/dsh-canvas/client'
import { EditorContextNotice, useEditorContext } from '../src/client/editor-context.tsx'
import type { CanvasInjected } from '../src/client/face.ts'

afterEach(cleanup)
const context: CanvasEditorContext = { scope: { directory: '/project', episode: brandString<EpisodeId>('e1') }, application: 'canvas', revision: 1, available: true }
function Editor({ publish }: { readonly publish: CanvasInjected['editorContext'] }) {
  return <EditorContextNotice state={useEditorContext(publish, context)} t={key => key} />
}

it('shows a failed publication and retries the same captured selection until acknowledged', async () => {
  const publish = vi.fn<NonNullable<CanvasInjected['editorContext']>>()
    .mockResolvedValue({ ok: true, value: undefined }).mockRejectedValueOnce(new Error('disconnected'))
  const view = render(<Editor publish={publish} />)
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toContain('editor.selectionFailed')
  fireEvent.click(screen.getByRole('button', { name: 'retry' }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(publish).toHaveBeenNthCalledWith(2, context)
  view.unmount()
  expect(publish).toHaveBeenLastCalledWith(undefined)
})
