// @vitest-environment jsdom
/** Every node card renders its own content, version bar, and status layer. */
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasNode, Shot } from '@deepseek-ai/dsh-canvas/client'
import { AudioNode, ImageNode, VideoNode } from '../src/client/nodes/media.tsx'
import { ScriptNode, StoryboardNode, TextNode, TimelineNode } from '../src/client/nodes/text.tsx'
import { GroupNode } from '../src/client/nodes/group.tsx'

afterEach(() => { cleanup() })

const shot = (id: string): Shot => ({
  id: id as never, title: id, shotSize: 'medium', visual: `画面 ${id}`, motion: '动作', camera: '固定', durationSec: 3,
  characters: [], props: [], dialogue: [], sfx: '', negative: '',
})

const node = (type: CanvasNode['type'], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id: 'n1' as never, type, title: `${type} 标题`, x: 0, y: 0, width: 280, height: 200, ...extra,
})

const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${JSON.stringify(params)}`

/** Renders one card component with the props a node would give it. */
function CardHost({ Card, props }: { readonly Card: (props: never) => ReactNode; readonly props: Record<string, unknown> }): ReactNode {
  return <>{Card(props as never)}</>
}

function mount(Card: (props: never) => ReactNode, data: Record<string, unknown>): { edit: ReturnType<typeof vi.fn> } {
  const edit = vi.fn(async () => {})
  const props = { data: { node: node('text'), readFile: async () => ({ ok: false, message: 'no' }), t, edit, ...data }, selected: false }
  render(<ReactFlowProvider><CardHost Card={Card} props={props} /></ReactFlowProvider>)
  return { edit }
}

it('draws an image card and reports a failed media read', async () => {
  mount(ImageNode, { node: node('image', { versions: [{ id: 'v1' as never, path: '/a.png', createdAt: 'now', origin: 'user' }], activeVersion: 'v1' as never }) })
  expect(screen.getByTitle('image 标题')).toBeTruthy()
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('media.failed') })
})

it('draws a video card with its duration and segment badge', () => {
  mount(VideoNode, {
    node: node('video', {
      versions: [{ id: 'v1' as never, path: '/a.mp4', durationMs: 3200, createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
      gen: { kind: 'video', prompt: '', params: {}, shot: { storyboard: 'b' as never, shots: ['s1' as never] } },
    }),
  })
  expect(screen.getByText('3.2s')).toBeTruthy()
})

it('draws an audio card with the line a voice node speaks', () => {
  mount(AudioNode, {
    node: node('audio', {
      versions: [{ id: 'v1' as never, path: '/a.mp3', createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
      gen: { kind: 'speech', prompt: '欢迎光临', params: {} },
    }),
  })
  expect(screen.getByText('欢迎光临')).toBeTruthy()
})

it('draws text, script, storyboard, and timeline content', () => {
  mount(TextNode, { node: node('text', { versions: [{ id: 'v1' as never, text: '一段说明', createdAt: 'now', origin: 'user' }], activeVersion: 'v1' as never }) })
  expect(screen.getByText('一段说明')).toBeTruthy()
  cleanup()
  mount(ScriptNode, { node: node('script', { versions: [{ id: 'v1' as never, text: '【场1】雨夜\n正文', createdAt: 'now', origin: 'user' }], activeVersion: 'v1' as never }) })
  expect(screen.getByText('script.scenes')).toBeTruthy()
  expect(screen.getByText('雨夜')).toBeTruthy()
  cleanup()
  mount(StoryboardNode, { node: node('storyboard', { versions: [{ id: 'v1' as never, shots: [shot('s1')], createdAt: 'now', origin: 'user' }], activeVersion: 'v1' as never }) })
  expect(screen.getByRole('table').textContent).toContain('s1')
  cleanup()
  mount(TimelineNode, { node: node('timeline', { timeline: { file: 't.json', durationMs: 12_000, exports: [] } }) })
  expect(screen.getByText(/timeline.clips/)).toBeTruthy()
})

it('switches version from the version bar', () => {
  const h = mount(ImageNode, {
    node: node('image', {
      versions: [
        { id: 'v1' as never, path: '/a.png', createdAt: 'now', origin: 'user' },
        { id: 'v2' as never, path: '/b.png', createdAt: 'now', origin: 'agent' },
      ],
      activeVersion: 'v2' as never,
    }),
  })
  fireEvent.click(screen.getByRole('button', { name: 'v1' }))
  expect(h.edit).toHaveBeenCalledWith([{ op: 'set_version', node: 'n1', version: 'v1' }])
})

it('shows a queued status and a retryable failure', () => {
  mount(ImageNode, {
    node: node('image', {
      versions: [{ id: 'v1' as never, path: '/a.png', createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
      gen: { kind: 'image', prompt: 'p', params: {} },
      status: { state: 'queued', jobId: 'j1' as never, at: 'now' },
    }),
  })
  expect(screen.getByText('status.queued')).toBeTruthy()
  cleanup()
  mount(ImageNode, {
    node: node('image', {
      versions: [{ id: 'v1' as never, path: '/a.png', createdAt: 'now', origin: 'user' }],
      activeVersion: 'v1' as never,
      gen: { kind: 'image', prompt: 'p', params: {} },
      status: { state: 'failed', at: 'now', error: '网关拒绝', retryable: true },
    }),
  })
  expect(screen.getByText(/网关拒绝/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'status.retry' })).toBeTruthy()
})

it('draws a group frame with its scene number and member count', () => {
  mount(GroupNode, { node: node('group', { sceneOrigin: { script: 'n1' as never, scene: 2 } }), members: 3 })
  expect(screen.getByText('2')).toBeTruthy()
  expect(screen.getByText('group.members:{"count":3}')).toBeTruthy()
})
