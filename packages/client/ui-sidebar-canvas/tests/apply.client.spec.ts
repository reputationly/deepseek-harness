/** The canvas tab type, copy, and seats follow the plugin lifetime; one face per Session reads and edits through the Remote. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { CanvasBody } from '../src/client/CanvasBody.tsx'
import { CanvasTitle } from '../src/client/CanvasTitle.tsx'
import type { CanvasInjected } from '../src/client/face.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

const view = (directory: string) => ({ directory, document: { version: 1 as const, nextId: 1, nodes: [], edges: [] } })

async function mountPlugin() {
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
  const canvas = {
    get: vi.fn(async (sessionId: SessionId) => ({ ok: true as const, value: view(`/projects/${sessionId}`) })),
    apply: vi.fn(async () => ({ ok: true as const, value: { refs: {}, created: [], skipped: [] } })),
  }
  const workspaceFiles = { readBytes: vi.fn() }
  ctx.provide('remote', {
    canvas, workspaceFiles,
    $on: (event: string, listener: (change: { directory: string }) => void) => {
      expect(event).toBe('canvas/change')
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as never)
  ctx.provide('remote.canvas', canvas as never)
  ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  const fiber = await ctx.plugin({ inject, apply })
  return {
    ctx, tabs, entries, dictionaries, canvas, workspaceFiles, listeners,
    emitChange(directory: string) { for (const listener of listeners) listener({ directory }) },
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
    expect(h.canvas.get).toHaveBeenLastCalledWith('s1')
    expect(first.hooks.canvas.getSnapshot()).toMatchObject({ status: 'ready', view: view('/projects/s1') })
    await second.load()

    await first.edit([{ op: 'remove', node: 'n1' }])
    expect(h.canvas.apply).toHaveBeenLastCalledWith('s1', [{ op: 'remove', node: 'n1' }])

    h.canvas.get.mockClear()
    h.emitChange('/projects/s2')
    expect(h.canvas.get.mock.calls).toEqual([['s2']])

    h.canvas.get.mockClear()
    h.ctx.emit('connection/reset')
    expect(h.canvas.get.mock.calls).toEqual([['s1'], ['s2']])
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
