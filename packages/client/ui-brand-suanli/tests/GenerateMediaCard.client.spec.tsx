// @vitest-environment jsdom
/** The generate_video / generate_music card: running, generated, failed, playback on demand, and its actions. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { GenerateMediaCard, type GenerateMediaCardProps } from '../src/client/GenerateMediaCard.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:media')
  URL.revokeObjectURL = vi.fn()
})

const t: TranslateNS<'gatewayStatus'> = (key, params) => {
  const dictionary: Partial<Record<string, string>> = zh
  const template = dictionary[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => JSON.stringify(params?.[name] ?? '').replace(/^"|"$/gu, ''))
}

const VIDEO = {
  status: 'generated', prompt: '海边日落', model: 'minimax-h3-2k', modelLabel: 'MiniMax H3',
  parameters: { ratio: '9:16', resolution: '768P', duration: '10' },
  media: [{ path: '/w/generated/sunset.mp4', mediaType: 'video/mp4' }],
}

function mount(over: { tool?: string; phase?: 'start' | 'result'; meta?: unknown; isError?: boolean; text?: string; fail?: boolean } = {}) {
  const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
  const loadMedia = vi.fn(async () => {
    if (over.fail === true) throw new Error('refused')
    return new Blob(['x'], { type: 'video/mp4' })
  })
  const openFile = vi.fn()
  const toolName = over.tool ?? 'generate_video'
  const block = {
    kind: 'tool-result', seq: 1, time: 1, callId: 'c1', name: toolName, args: {}, call: null, callTime: null,
    content: over.text === undefined ? [] : [{ type: 'text', text: over.text }], isError: over.isError ?? false,
    meta: over.meta, subCalls: [],
  }
  const props = { phase: over.phase ?? 'result', toolName, block, t, inputActions, loadMedia, openFile } as unknown as GenerateMediaCardProps
  const view = render(<GenerateMediaCard {...props} />)
  return { inputActions, loadMedia, openFile, view }
}

it('shows video progress while the call runs', () => {
  mount({ phase: 'start' })
  expect(screen.getAllByText('正在生成视频…').length).toBeGreaterThan(0)
})

it('reads the file only when the user plays it, then shows a player with fullscreen controls', async () => {
  const { loadMedia, view } = mount({ meta: VIDEO })
  expect(screen.getByText('MiniMax H3 · 9:16 · 768P · 10')).toBeTruthy()
  expect(loadMedia).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '播放视频' }))
  await vi.waitFor(() => { expect(view.container.querySelector('video')).not.toBeNull() })
  const video = view.container.querySelector('video')
  expect(video?.getAttribute('src')).toBe('blob:media')
  expect(video?.hasAttribute('controls')).toBe(true)
  expect(loadMedia).toHaveBeenCalledWith('/w/generated/sunset.mp4', 'video/mp4', expect.any(AbortSignal))
  expect(screen.getByRole('button', { name: '下载' })).toBeTruthy()
})

it('plays music through an audio player', async () => {
  const { view } = mount({ tool: 'generate_music', meta: { ...VIDEO, parameters: { is_instrumental: 'true' }, media: [{ path: '/w/generated/song.mp3', mediaType: 'audio/mpeg' }] } })
  expect(screen.getByText('音乐已生成')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '播放音频' }))
  await vi.waitFor(() => { expect(view.container.querySelector('audio')).not.toBeNull() })
})

it('names the file it could not read and still offers to open it', async () => {
  const { openFile } = mount({ meta: VIDEO, fail: true })
  fireEvent.click(screen.getByRole('button', { name: '播放视频' }))
  await vi.waitFor(() => { expect(screen.getByText('无法读取 /w/generated/sunset.mp4')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: '打开文件' }))
  expect(openFile).toHaveBeenCalledWith('/w/generated/sunset.mp4')
})

it('regenerates by sending the same requirements from the composer', () => {
  const { inputActions } = mount({ meta: VIDEO })
  fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
  expect(inputActions.setDraft).toHaveBeenCalledWith('按同样的要求重新生成视频：海边日落（MiniMax H3 · 9:16 · 768P · 10）')
  expect(inputActions.submit).toHaveBeenCalledTimes(1)
})

it('shows the failure text', () => {
  mount({ isError: true, text: 'Video generation failed: 当前不支持' })
  expect(screen.getByText('视频生成失败')).toBeTruthy()
  expect(screen.getByText('Video generation failed: 当前不支持')).toBeTruthy()
})
