/** The canvas tab type, copy, and seats follow the plugin lifetime; one face per Session reads and edits through the Remote. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { CanvasBody } from '../src/client/CanvasBody.tsx'
import { CanvasTitle } from '../src/client/CanvasTitle.tsx'
import type { CanvasInjected } from '../src/client/face.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

const view = (directory: string) => ({
  directory,
  episode: { id: 'e1' as never, title: 'Canvas' },
  revisions: { canvas: 0 },
  document: { version: 3 as const, revision: 0, nextId: 1, nodes: [], edges: [] },
})

async function mountPlugin(withMedia = true) {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  ctx.provide('sidebarRightTabs', tabs)
  const entries: { name: string; key?: string; locale?: string; component: unknown; inject?: (id: SessionId) => unknown }[] = []
  const dictionaries = new Map<string, unknown>()
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: Omit<typeof entries[number], 'component'>, component: unknown) => {
      const entry = { ...options, component }
      entries.push(entry)
      return () => { entries.splice(entries.indexOf(entry), 1) }
    },
  } as never)
  ctx.provide('locale', {
    bind: () => (key: string) => key,
    register: (name: string, values: unknown) => { dictionaries.set(name, values); return () => { dictionaries.delete(name) } },
  } as never)
  const listeners = new Set<(change: { directory: string }) => void>()
  const renderListeners = new Set<(change: { directory: string }) => void>()
  const canvas = {
    get: vi.fn(async (sessionId: SessionId) => ({ ok: true as const, value: view(`/projects/${sessionId}`) })),
    apply: vi.fn(async () => ({ ok: true as const, value: { refs: {}, created: [], skipped: [] } })),
    bible: vi.fn(async () => ({ ok: true as const, value: { bible: { version: 1, revision: 0, logline: '', style: { visual: '', aspect: '9:16' }, entries: [] }, revision: 0 } })),
  }
  const workspaceFiles = { readBytes: vi.fn() }
  const plan = { state: 'ready' as const, lines: [], totals: { videoCalls: 0, videoSeconds: 0, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [] }
  const media = {
    capabilities: vi.fn(async () => ({ ok: true as const, value: [] })),
    planNodes: vi.fn(async () => ({ ok: true as const, value: plan })),
    generateNodes: vi.fn(async () => ({ ok: true as const, value: plan })),
    videoPreview: vi.fn(async () => ({ ok: true as const, value: '/projects/s1/compatible.webm' })),
    pendingTimelineRenders: vi.fn(async () => ({ ok: true as const, value: [] })),
    claimTimelineRender: vi.fn(async () => ({ ok: true as const, value: undefined })),
  }
  // Match the gateway's service-backed namespaces, rather than plain nested objects.
  class Remote extends Service {
    constructor(owner: Context) { super(owner, 'remote') }
    $on(event: string, listener: (change: { directory: string }) => void): () => void {
      expect(['canvas/change', 'media/render-change']).toContain(event)
      const target = event === 'canvas/change' ? listeners : renderListeners
      target.add(listener)
      return () => { target.delete(listener) }
    }
  }
  new Remote(ctx)
  ctx.provide('remote.canvas', canvas as never)
  class Media extends Service {
    constructor(owner: Context) { super(owner, 'remote.media') }
  }
  // A sibling provider requires inject; a provision on the consumer's ancestor does not.
  const mediaProvider = withMedia
    ? await ctx.plugin({ apply: (owner: Context) => { Object.assign(new Media(owner), media) } })
    : undefined
  ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  const fiber = await ctx.plugin({ inject, apply })
  return {
    ctx, tabs, entries, dictionaries, canvas, workspaceFiles, media, listeners, renderListeners,
    emitChange(directory: string) { for (const listener of listeners) listener({ directory }) },
    async stopMedia() { await mediaProvider?.dispose() },
    async dispose() { await fiber.dispose(); await ctx.fiber.dispose() },
  }
}

it('registers the canvas type, copy, body, and title, then releases them on unload', async () => {
  expect(hostApply).not.toThrow()
  const h = await mountPlugin()
  try {
    const definition = h.tabs.get('canvas')!
    expect(definition.title('sidebar://canvas')).toBe('title')
    expect(definition.multiple).toBeUndefined()
    expect(definition.guide?.map(entry => [entry.order, entry.title(), entry.description?.()])).toEqual([[40, 'title', 'guide.description']])
    const Icon = definition.guide?.[0]?.icon
    if (Icon === undefined) throw new Error('Canvas guide icon was not registered')
    expect(renderToStaticMarkup(createElement(Icon))).toContain('<svg')
    expect(h.dictionaries.get('sidebarCanvas')).toEqual({ en, zh, ja, es, fr, de, ru, pt })
    expect(h.entries.map(entry => [entry.name, entry.key, entry.component, entry.locale])).toEqual([
      ['sidebar.right.pane.tab', '@deepseek-ai/dsh-client-ui-sidebar-canvas', CanvasBody, 'sidebarCanvas'],
      ['sidebar.right.pane.tab.title', '@deepseek-ai/dsh-client-ui-sidebar-canvas', CanvasTitle, undefined],
    ])
    expect(h.listeners.size).toBe(1)
  } finally {
    await h.dispose()
  }
  expect(h.tabs.get('canvas')).toBeUndefined()
  expect(h.entries).toEqual([])
  expect(h.dictionaries.size).toBe(0)
  expect(h.listeners.size).toBe(0)
})

it('gives each Session one stable face that reads, edits, and follows Host changes of its own project', async () => {
  const h = await mountPlugin()
  try {
    const faceOf = h.entries[0]!.inject as (sessionId: SessionId) => CanvasInjected
    const first = faceOf('s1' as SessionId)
    const second = faceOf('s2' as SessionId)
    expect(faceOf('s1' as SessionId)).toBe(first)
    expect(second).not.toBe(first)

    await first.load()
    expect(h.canvas.get).toHaveBeenLastCalledWith('s1', undefined)
    expect(first.hooks.canvas.getSnapshot()).toMatchObject({ status: 'ready', view: view('/projects/s1') })
    await second.load()

    await first.edit([{ op: 'remove', node: 'n1' }])
    expect(h.canvas.apply).toHaveBeenLastCalledWith('s1', [{ op: 'remove', node: 'n1' }], 0, 'e1', '/projects/s1')

    h.canvas.get.mockClear()
    h.emitChange('/projects/s2')
    expect(h.canvas.get.mock.calls).toEqual([['s2', undefined]])

    h.canvas.get.mockClear()
    h.ctx.emit('connection/reset')
    expect(h.canvas.get.mock.calls).toEqual([['s1', undefined], ['s2', undefined]])
    expect(first.hooks.canvas.getSnapshot().status).toBe('loading')
  } finally {
    await h.dispose()
  }
})

it('reads node media through the Session workspace and reports the Host failure', async () => {
  const h = await mountPlugin()
  try {
    const face = (h.entries[0]!.inject as (sessionId: SessionId) => CanvasInjected)('s1' as SessionId)
    const signal = new AbortController().signal
    const data = new Uint8Array([1, 2, 3])
    h.workspaceFiles.readBytes.mockResolvedValueOnce({ ok: true, value: { data } })
    await expect(face.readFile('/projects/s1/a.png', signal)).resolves.toEqual({ ok: true, data })
    expect(h.workspaceFiles.readBytes).toHaveBeenLastCalledWith('s1', '/projects/s1/a.png', {}, signal)
    h.workspaceFiles.readBytes.mockResolvedValueOnce({ ok: false, error: { code: 'workspace-file/too-large', message: 'too large' } })
    await expect(face.readFile('/projects/s1/big.mp4', signal)).resolves.toEqual({ ok: false, message: 'too large' })
  } finally {
    await h.dispose()
  }
})

it('stops following Host changes after unload', async () => {
  const h = await mountPlugin()
  const face = (h.entries[0]!.inject as (sessionId: SessionId) => CanvasInjected)('s1' as SessionId)
  await face.load()
  await h.dispose()
  h.canvas.get.mockClear()
  h.emitChange('/projects/s1')
  expect(h.canvas.get).not.toHaveBeenCalled()
})

it('reads the bible and drives media planning through the optional namespace', async () => {
  const h = await mountPlugin()
  try {
    const face = h.entries[0]!.inject!('s1' as SessionId) as {
      bible: () => Promise<unknown>
      planNodes: (nodes: string[]) => Promise<unknown>
      generateNodes: (nodes: string[]) => Promise<unknown>
    }
    await expect(face.bible()).resolves.toMatchObject({ revision: 0 })
    await expect(face.planNodes(['n1'])).resolves.toMatchObject({ state: 'ready' })
    await expect(face.generateNodes(['n1'])).resolves.toMatchObject({ state: 'ready' })
    expect(h.canvas.bible).toHaveBeenCalledWith('s1')
    expect(h.media.planNodes).toHaveBeenCalledWith('s1', ['n1'], undefined)
    expect(h.media.generateNodes).toHaveBeenCalledWith('s1', ['n1'], undefined)
  } finally {
    await h.dispose()
  }
})

it('keeps the canvas usable without any media namespace', async () => {
  const h = await mountPlugin(false)
  try {
    const face = h.entries[0]!.inject!('s1' as SessionId) as CanvasInjected
    await face.load()
    expect(face.hooks.canvas.getSnapshot().status).toBe('ready')
    await expect(face.capabilities('generate_image')).resolves.toEqual([])
    await expect(face.planNodes?.(['n1'])).resolves.toBeUndefined()
    await expect(face.generateNodes?.(['n1'])).resolves.toBeUndefined()
    await expect(face.previewVideo?.(brandString<CanvasNodeId>('n1'), brandString<VersionId>('v1'), { directory: '/projects/s1', episode: brandString<EpisodeId>('e1') }, new AbortController().signal))
      .resolves.toEqual({ ok: false, message: 'Video previews are unavailable' })
  } finally {
    await h.dispose()
  }
})

it('releases the optional namespace on provider unload while preserving the canvas face', async () => {
  const h = await mountPlugin()
  try {
    const faceOf = h.entries[0]!.inject!
    const face = faceOf('s1' as SessionId) as CanvasInjected
    await face.capabilities('generate_video')
    expect(h.media.capabilities).toHaveBeenCalledOnce()
    await h.stopMedia()
    expect(faceOf('s1' as SessionId)).toBe(face)
    await expect(face.capabilities('generate_video')).resolves.toEqual([])
    await expect(face.previewVideo?.(brandString<CanvasNodeId>('n1'), brandString<VersionId>('v1'), { directory: '/projects/s1', episode: brandString<EpisodeId>('e1') }, new AbortController().signal))
      .resolves.toEqual({ ok: false, message: 'Video previews are unavailable' })
    expect(h.media.capabilities).toHaveBeenCalledOnce()
    expect(h.media.videoPreview).not.toHaveBeenCalled()
    await face.load()
    expect(face.hooks.canvas.getSnapshot().status).toBe('ready')
  } finally {
    await h.dispose()
  }
})

it('surfaces remote failures for capabilities and plans', async () => {
  const h = await mountPlugin()
  try {
    h.media.capabilities.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'cap boom' } } as never)
    h.media.planNodes.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'plan boom' } } as never)
    h.media.generateNodes.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'gen boom' } } as never)
    h.canvas.bible.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'bible boom' } } as never)
    const face = h.entries[0]!.inject!('s1' as SessionId) as {
      capabilities: (operation: string) => Promise<unknown>
      planNodes: (nodes: string[]) => Promise<unknown>
      generateNodes: (nodes: string[]) => Promise<unknown>
      bible: () => Promise<unknown>
    }
    await expect(face.capabilities('generate_image')).rejects.toThrow('cap boom')
    await expect(face.planNodes(['n1'])).rejects.toThrow('plan boom')
    await expect(face.generateNodes(['n1'])).rejects.toThrow('gen boom')
    await expect(face.bible()).rejects.toThrow('bible boom')
  } finally {
    await h.dispose()
  }
})

it('returns capabilities from the successful namespace', async () => {
  const h = await mountPlugin()
  try {
    h.media.capabilities.mockResolvedValueOnce({ ok: true, value: [{ id: 'c', model: 'm', operation: 'generate_image', params: [] }] } as never)
    const face = h.entries[0]!.inject!('s1' as SessionId) as { capabilities: (operation: string) => Promise<unknown> }
    await expect(face.capabilities('generate_image')).resolves.toHaveLength(1)
    expect(h.media.capabilities).toHaveBeenCalledWith('s1', 'generate_image')
  } finally {
    await h.dispose()
  }
})

it('prepares compatible video through the optional namespace before reading its bytes', async () => {
  const h = await mountPlugin()
  try {
    const face = h.entries[0]!.inject!('s1' as SessionId) as CanvasInjected
    const signal = new AbortController().signal
    const data = new Uint8Array([1, 2, 3])
    h.workspaceFiles.readBytes.mockResolvedValueOnce({ ok: true, value: { data } })
    const scope = { directory: '/projects/s1', episode: brandString<EpisodeId>('e1') }
    const node = brandString<CanvasNodeId>('n1'), version = brandString<VersionId>('v1')
    await expect(face.previewVideo?.(node, version, scope, signal)).resolves.toEqual({ ok: true, data })
    expect(h.media.videoPreview).toHaveBeenCalledWith('s1', 'n1', 'v1', scope)
    expect(h.workspaceFiles.readBytes).toHaveBeenCalledWith('s1', '/projects/s1/compatible.webm', {}, signal)
    h.media.videoPreview.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'preview failed' } } as never)
    await expect(face.previewVideo?.(node, version, scope, signal)).resolves.toEqual({ ok: false, message: 'preview failed' })
    expect(h.workspaceFiles.readBytes).toHaveBeenCalledTimes(1)
  } finally {
    await h.dispose()
  }
})

it('passes the Host apply arity and reports a rejected edit through the canvas notice', async () => {
  const h = await mountPlugin()
  try {
    const face = h.entries[0]!.inject!('s1' as SessionId) as CanvasInjected
    await face.load()
    h.canvas.apply.mockRejectedValueOnce(new Error('apply boom'))
    await face.edit([{ op: 'remove', node: 'n1' }])
    expect(h.canvas.apply).toHaveBeenCalledWith('s1', [{ op: 'remove', node: 'n1' }], 0, 'e1', '/projects/s1')
    expect(face.hooks.canvas.getSnapshot().notice).toBe('apply boom')
  } finally {
    await h.dispose()
  }
})
