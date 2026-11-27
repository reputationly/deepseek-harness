// @vitest-environment jsdom
/** The generate_image card: running, generated, cancelled, failed, and its actions. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { GenerateImageCard, type GenerateImageCardProps } from '../src/client/GenerateImageCard.tsx'
import { imageResultOf } from '../src/client/image-result.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: TranslateNS<'gatewayStatus'> = (key, params) => {
  const dictionary: Partial<Record<string, string>> = zh
  const template = dictionary[key] ?? key
  return template.replace(/\{(\w+)\}/gu, (_match, name: string) => JSON.stringify(params?.[name] ?? '').replace(/^"|"$/gu, ''))
}

const ATTACHMENT = { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }

const META = {
  status: 'generated', prompt: '小猫玩耍', model: 'minimax-h3-image', modelLabel: 'MiniMax H3 Image',
  parameters: { aspect_ratio: '9:16', resolution: '2K' },
  images: [{ path: '/w/generated/cat.png', attachment: ATTACHMENT }],
}

function mount(over: { phase?: 'start' | 'result'; meta?: unknown; isError?: boolean; text?: string; creative?: boolean; ready?: boolean } = {}) {
  const openInCreative = vi.fn(() => over.creative ?? true)
  const useCreativeReady = (select: (ready: boolean) => boolean) => select(over.ready ?? true)
  const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
  const renderFactorySlot = vi.fn((_name: string, input: { images: readonly { label?: string }[] }) =>
    <div data-testid="gallery">{input.images.map(image => image.label).join(',')}</div>)
  const loadImage = vi.fn(async () => 'blob:cat')
  const block = {
    kind: 'tool-result', seq: 1, time: 1, callId: 'c1', name: 'generate_image', args: {}, call: null, callTime: null,
    content: over.text === undefined ? [] : [{ type: 'text', text: over.text }], isError: over.isError ?? false,
    meta: over.meta, subCalls: [],
  }
  const props = {
    phase: over.phase ?? 'result', block, t, inputActions, renderFactorySlot, loadImage, openInCreative, useCreativeReady,
  } as unknown as GenerateImageCardProps
  render(<GenerateImageCard {...props} />)
  return { inputActions, renderFactorySlot, loadImage, openInCreative }
}

it('shows progress while the call runs', () => {
  mount({ phase: 'start' })
  expect(screen.getAllByText('正在生成图片…').length).toBeGreaterThan(0)
})

it('shows the generated images with model, parameters, and actions', () => {
  const { renderFactorySlot } = mount({ meta: META })
  expect(screen.getByText('已生成 1 张图片')).toBeTruthy()
  expect(screen.getByText('MiniMax H3 Image · 9:16 · 2K')).toBeTruthy()
  expect(screen.getByTestId('gallery').textContent).toBe('cat.png')
  expect(renderFactorySlot).toHaveBeenCalledWith('conversation.images.content', expect.objectContaining({ align: 'start' }))
  expect(screen.getByRole('button', { name: '下载' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '复制提示词' })).toBeTruthy()
})

it('regenerates by sending the same requirements from the composer', () => {
  const { inputActions } = mount({ meta: META })
  fireEvent.click(screen.getByRole('button', { name: '重新生成' }))
  expect(inputActions.setDraft).toHaveBeenCalledWith('按同样的要求重新生成图片：小猫玩耍（MiniMax H3 Image · 9:16 · 2K）')
  expect(inputActions.submit).toHaveBeenCalledTimes(1)
})

it('downloads each stored image through the authorized loader', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const { loadImage } = mount({ meta: META })
  fireEvent.click(screen.getByRole('button', { name: '下载' }))
  await vi.waitFor(() => { expect(click).toHaveBeenCalledTimes(1) })
  expect(loadImage).toHaveBeenCalledWith(ATTACHMENT)
  click.mockRestore()
})

it('hands the stored images to the creative workbench', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
  const { openInCreative } = mount({ meta: META })
  fireEvent.click(screen.getByRole('button', { name: '拿去精修' }))
  await vi.waitFor(() => { expect(openInCreative).toHaveBeenCalledTimes(1) })
  expect(openInCreative).toHaveBeenCalledWith({ prompt: '小猫玩耍', model: 'MiniMax H3 Image', images: [{ b64: 'AQID', mime: 'image/png' }] })
  expect(screen.queryByText('「创作」未启用。')).toBeNull()
  fetchSpy.mockRestore()
})

it('says so when the creative workbench is not enabled', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }))
  mount({ meta: META, creative: false })
  fireEvent.click(screen.getByRole('button', { name: '拿去精修' }))
  expect(await screen.findByText('「创作」未启用。')).toBeTruthy()
  fetchSpy.mockRestore()
})

it('offers no refine button while the creative workbench is off', () => {
  mount({ meta: META, ready: false })
  expect(screen.queryByRole('button', { name: '拿去精修' })).toBeNull()
})

it('lists saved paths when no image reference was stored', () => {
  mount({ meta: { ...META, images: [{ path: '/w/generated/cat.png' }] } })
  expect(screen.getByText('/w/generated/cat.png')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '下载' })).toBeNull()
})

it('reports a cancelled generation', () => {
  mount({ meta: { ...META, status: 'cancelled', images: [] } })
  expect(screen.getByText('已取消生成')).toBeTruthy()
})

it('shows the failure text', () => {
  mount({ isError: true, text: '图片生成失败：额度不足' })
  expect(screen.getByText('图片生成失败')).toBeTruthy()
  expect(screen.getByText('图片生成失败：额度不足')).toBeTruthy()
})

it('falls back to the result text for unknown metadata', () => {
  mount({ meta: { status: 'other' }, text: 'plain' })
  expect(screen.getByText('plain')).toBeTruthy()
})

it('reads only well-formed metadata', () => {
  expect(imageResultOf(null)).toBeNull()
  expect(imageResultOf([])).toBeNull()
  expect(imageResultOf({ ...META, prompt: 1 })).toBeNull()
  expect(imageResultOf({ ...META, parameters: [] })).toBeNull()
  expect(imageResultOf({ ...META, parameters: { a: 1 }, images: [3, { path: 1 }, { path: 'p', attachment: { attachmentId: 'x' } }] }))
    .toEqual({ status: 'generated', prompt: '小猫玩耍', modelLabel: 'MiniMax H3 Image', parameters: [], images: [{ path: 'p' }] })
})
