/** Register the project canvas tab type in the right Sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconLayersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CanvasBody } from './CanvasBody.tsx'
import { CanvasSource } from './canvas-source.ts'
import { CanvasTitle } from './CanvasTitle.tsx'
import type { CanvasInjected } from './face.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'

export type { CanvasState } from './canvas-source.ts'
export type { CanvasFile, CanvasInjected, ReadCanvasFile } from './face.ts'

/** Services needed by the canvas tab's seats. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.canvas', 'remote.workspaceFiles']

/** The tab kind this package owns, and the key its body and title register under. */
const KIND = 'canvas'
const ID = '@deepseek-ai/dsh-client-ui-sidebar-canvas'

/**
 * Register the canvas type, its copy, body, and title, and follow Host change notifications.
 * @param ctx - Client root Context with the sidebar and the canvas Remote namespace.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  const sources = new Map<SessionId, CanvasSource>()
  const faces = new Map<SessionId, CanvasInjected>()
  // One face per Session: its calls keep their identity across renders of the tab.
  const faceOf = (sessionId: SessionId): CanvasInjected => {
    let face = faces.get(sessionId)
    if (face === undefined) {
      const source = new CanvasSource({
        get: () => ctx.remote.canvas.get(sessionId, undefined),
        apply: (operations, baseRevision) => ctx.remote.canvas.apply(sessionId, operations, baseRevision, undefined),
      })
      sources.set(sessionId, source)
      face = {
        hooks: { canvas: source.state },
        load: source.load,
        edit: source.edit,
        dismiss: source.dismiss,
        planNodes: async (nodes) => {
          const media = ctx.get('remote.media')
          if (media === undefined) return undefined
          const result = await media.planNodes(sessionId, nodes)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        generateNodes: async (nodes, token) => {
          const media = ctx.get('remote.media')
          if (media === undefined) return undefined
          const result = await media.generateNodes(sessionId, nodes, token)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        bible: async () => {
          const result = await ctx.remote.canvas.bible(sessionId)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        capabilities: async (operation) => {
          // The media namespace is optional: a deployment can show the canvas without generating.
          const media = ctx.get('remote.media')
          if (media === undefined) return []
          const result = await media.capabilities(sessionId, operation)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        readFile: async (path, signal) => {
          const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
          return result.ok ? { ok: true, data: result.value.data } : { ok: false, message: result.error.message }
        },
      }
      faces.set(sessionId, face)
    }
    return face
  }
  ctx.effect(() => () => {
    for (const source of sources.values()) source.dispose()
    sources.clear()
    faces.clear()
  }, 'ui-sidebar-canvas.sources')
  ctx.effect(() => ctx.remote.$on('canvas/change', (change) => {
    for (const source of sources.values()) source.changed(change.directory)
  }), 'ui-sidebar-canvas.changes')
  ctx.on('connection/reset', () => {
    for (const source of sources.values()) source.reset()
  })
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar-canvas.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: KIND, priority: 'builtin', title: () => t('title'),
    guide: [{ id: 'open', order: 40, title: () => t('title'), description: () => t('guide.description'), icon: IconLayersOutlineRegular }],
  }), 'ui-sidebar-canvas.type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: NS,
    inject: faceOf,
  }, CanvasBody)), 'ui-sidebar-canvas.body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ID,
  }, CanvasTitle)), 'ui-sidebar-canvas.title')
}
