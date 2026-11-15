/** Register the project canvas tab type in the right Sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import { IconLayersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CanvasBody } from './CanvasBody.tsx'
import { CanvasSource } from './canvas-source.ts'
import { CanvasTitle } from './CanvasTitle.tsx'
import { TimelineWorker } from './timeline-worker.ts'
import { TimelineSource } from './timeline-source.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { CanvasInjected } from './face.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'

export type { CanvasState } from './canvas-source.ts'
export type { CanvasFile, CanvasInjected, ReadCanvasFile } from './face.ts'

/** Services needed by the canvas tab's seats. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.canvas', 'remote.workspaceFiles']

/** The tab kind this package owns, and the key its body and title register under. */
const KIND = 'canvas'
const ID = '@deepseek-ai/dsh-client-ui-sidebar-canvas'

async function valueOf<T>(pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function encodedWindow(bytes: Uint8Array): string {
  let binary = ''
  for (let from = 0; from < bytes.length; from += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(from, from + 0x8000))
  return btoa(binary)
}

function renderEnvironment(): string {
  const canvas = new OffscreenCanvas(1, 1),
    gl = canvas.getContext('webgl')
  let gpu = 'unavailable'
  if (gl !== null) {
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    gpu = debug === null ? String(gl.getParameter(gl.RENDERER)) : String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  return JSON.stringify({ renderer: 1, codecLibrary: 'mediabunny/1.44.2', browser: navigator.userAgent, gpu })
}

/**
 * Register the canvas type, its copy, body, and title, and follow Host change notifications.
 * @param ctx - Client root Context with the sidebar and the canvas Remote namespace.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  let media: Context['remote']['media'] | undefined
  let renderer: TimelineWorker | undefined
  const sources = new Map<SessionId, CanvasSource>()
  const timelines = new Map<SessionId, TimelineSource>()
  const faces = new Map<SessionId, CanvasInjected>()
  // Bind an optional namespace in its own injection scope so the canvas remains available without it.
  ctx.inject(['remote.media'], (mediaCtx) => {
    media = mediaCtx.remote.media
    const renderMedia = mediaCtx.remote.media
    const owned = new TimelineWorker({
      pending: session => valueOf(renderMedia.pendingTimelineRenders(session)),
      claim: (session, job) => valueOf(renderMedia.claimTimelineRender(session, job, renderEnvironment())),
      fail: (session, work, code, message) =>
        valueOf(renderMedia.failTimelineRender(session, work.jobId, work.lease, code, message)),
      report: (error) => { ctx.logger.warn(error) },
      io: (session, work) => ({
        read: async (path, offset, length, signal) =>
          (await valueOf(ctx.remote.workspaceFiles.readBytes(session, path, { range: { offset, length } }, signal)))
            .data,
        size: async (path, signal) => {
          const result = await valueOf(ctx.remote.workspaceFiles.stat(session, path, signal))
          if (result.bytes === undefined) throw new Error('Cannot determine media file size')
          return result.bytes
        },
        compatible: asset =>
          valueOf(renderMedia.compatibleTimelineAsset(session, work.jobId, work.lease, asset.node, asset.version)),
        append: (part, offset, bytes) =>
          valueOf(
            renderMedia.appendTimelineRender(session, work.jobId, work.lease, part, offset, encodedWindow(bytes)),
          ),
        complete: async (part) => {
          await valueOf(renderMedia.completeTimelineRender(session, work.jobId, work.lease, part))
        },
        progress: (progress, assembling) =>
          valueOf(renderMedia.timelineRenderProgress(session, work.jobId, work.lease, progress, assembling)),
        report: (error) => { ctx.logger.warn(error) },
      }),
    })
    renderer = owned
    for (const session of sources.keys()) owned.wake(session)
    for (const timeline of timelines.values()) void timeline.load()
    mediaCtx.effect(
      () => async () => {
        media = undefined
        if (renderer === owned) renderer = undefined
        await owned.dispose()
      },
      'ui-sidebar-canvas.media',
    )
  })
  // One face per Session: its calls keep their identity across renders of the tab.
  const faceOf = (sessionId: SessionId): CanvasInjected => {
    let face = faces.get(sessionId)
    if (face === undefined) {
      const source = new CanvasSource({
        get: () => ctx.remote.canvas.get(sessionId, undefined),
        apply: (operations, baseRevision, scope) =>
          ctx.remote.canvas.apply(sessionId, operations, baseRevision, scope.episode, scope.directory),
      })
      sources.set(sessionId, source)
      const timeline = new TimelineSource({
        get: (node, binding) => ctx.remote.canvas.timeline(sessionId, node, binding.episode, binding.directory),
        edit: (node, operations, revision, spec, binding) =>
          ctx.remote.canvas.editTimeline(
            sessionId,
            node,
            operations,
            revision,
            spec,
            binding.episode,
            binding.directory,
          ),
        history: (node, binding) =>
          ctx.remote.canvas.timelineHistory(sessionId, node, binding.episode, binding.directory),
        restore: (node, revision, baseRevision, mode, binding) =>
          ctx.remote.canvas.restoreTimeline(
            sessionId,
            node,
            revision,
            baseRevision,
            mode,
            binding.episode,
            binding.directory,
          ),
        status: async (node, binding) => media?.timelineStatus(sessionId, node, binding.episode, binding.directory),
        start: async (node, revision, binding) =>
          media?.renderTimeline(sessionId, node, revision, binding.episode, binding.directory),
        cancel: async job => media?.cancelMediaJob(sessionId, job),
        clear: async (node, binding) => media?.clearTimelineCache(sessionId, node, binding.episode, binding.directory),
        export: async (node, revision, binding) => {
          const result = await media?.exportTimeline(sessionId, node, revision, binding.episode, binding.directory)
          if (result?.ok === true) await source.load()
          return result
        },
        report: (error) => { ctx.logger.warn(error) },
      })
      timelines.set(sessionId, timeline)
      renderer?.wake(sessionId)
      face = {
        hooks: {
          canvas: source.state,
          timeline: timeline.state,
          localeState: {
            getSnapshot: () => ctx.locale.getSnapshot(),
            subscribe: notify => ctx.locale.subscribe(notify),
          },
        },
        timeline: {
          open: timeline.open,
          load: timeline.load,
          edit: timeline.edit,
          merge: timeline.merge,
          discard: timeline.discard,
          render: timeline.render,
          cancel: timeline.cancel,
          clear: timeline.clear,
          export: timeline.export,
          readHistory: timeline.readHistory,
          restore: timeline.restore,
        },
        load: async () => {
          await source.load()
          renderer?.wake(sessionId)
        },
        edit: source.edit,
        dismiss: source.dismiss,
        editMedia: request => media?.editMedia(sessionId, request) ?? Promise.resolve(undefined),
        importVideo: async (node, scope, file, signal) => {
          const uploads = ctx.get('fileUpload')
          if (media === undefined || uploads === undefined) return undefined
          const uploaded = await uploads.upload(sessionId, file, file.name, signal)
          if (!uploaded.ok) return uploaded
          signal.throwIfAborted()
          return media.importVideo(sessionId, { scope, node, receipt: uploaded.value.receiptId })
        },
        importAudio: async (node, scope, file, signal) => {
          const uploads = ctx.get('fileUpload')
          if (media === undefined || uploads === undefined) return undefined
          const uploaded = await uploads.upload(sessionId, file, file.name, signal)
          if (!uploaded.ok) return uploaded
          signal.throwIfAborted()
          return media.importAudio(sessionId, { scope, node, receipt: uploaded.value.receiptId })
        },
        videoPath: (node, version, scope) =>
          media?.videoPreview(sessionId, node, version, scope) ?? Promise.resolve(undefined),
        editorContext: context => ctx.remote.canvas.editorContext(sessionId, context),
        planNodes: async (nodes, scope) => {
          if (media === undefined) return undefined
          const result = await media.planNodes(sessionId, nodes, scope)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        generateNodes: async (nodes, token, scope) => {
          if (media === undefined) return undefined
          const result = await media.generateNodes(sessionId, nodes, token, scope)
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
          if (media === undefined) return []
          const result = await media.capabilities(sessionId, operation)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        readFile: async (path, signal) => {
          const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
          return result.ok ? { ok: true, data: result.value.data } : { ok: false, message: result.error.message }
        },
        previewVideo: async (node, version, scope, signal) => {
          if (media === undefined) return { ok: false, message: 'Video previews are unavailable' }
          const prepared = await media.videoPreview(sessionId, node, version, scope)
          if (!prepared.ok) return { ok: false, message: prepared.error.message }
          const file = await ctx.remote.workspaceFiles.readBytes(sessionId, prepared.value, {}, signal)
          return file.ok ? { ok: true, data: file.value.data } : { ok: false, message: file.error.message }
        },
      }
      faces.set(sessionId, face)
    }
    return face
  }
  ctx.effect(
    () => async () => {
      for (const source of sources.values()) source.dispose()
      await Promise.all([...timelines.values()].map(timeline => timeline.dispose()))
      timelines.clear()
      sources.clear()
      faces.clear()
    },
    'ui-sidebar-canvas.sources',
  )
  ctx.effect(
    () =>
      ctx.remote.$on('canvas/change', (change) => {
        for (const source of sources.values()) source.changed(change.directory)
        for (const timeline of timelines.values()) {
          const state = timeline.state.getSnapshot()
          if (
            state.binding?.directory === change.directory &&
            (change.episode === undefined || state.binding.episode === change.episode)
          )
            void timeline.load()
        }
      }),
    'ui-sidebar-canvas.changes',
  )
  ctx.effect(
    () =>
      ctx.remote.$on('media/render-change', (notice) => {
        renderer?.changed(notice)
        const timeline = timelines.get(notice.sessionId),
          state = timeline?.state.getSnapshot()
        if (
          state?.node === notice.node &&
          state.binding?.directory === notice.directory &&
          state.binding.episode === notice.episode
        )
          void timeline?.load()
      }),
    'ui-sidebar-canvas.renders',
  )
  ctx.on('connection/reset', () => {
    renderer?.reset()
    for (const source of sources.values()) source.reset()
    for (const timeline of timelines.values()) timeline.reset()
  })
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar-canvas.copy')
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'builtin',
        title: () => t('title'),
        guide: [
          {
            id: 'open',
            order: 40,
            title: () => t('title'),
            description: () => t('guide.description'),
            icon: IconLayersOutlineRegular,
          },
        ],
      }),
    'ui-sidebar-canvas.type',
  )
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: ID,
            locale: NS,
            inject: faceOf,
          },
          CanvasBody,
        ),
      ),
    'ui-sidebar-canvas.body',
  )
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab.title', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab.title',
            key: ID,
          },
          CanvasTitle,
        ),
      ),
    'ui-sidebar-canvas.title',
  )
}
