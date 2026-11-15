/** Compatible video paths become authorized stream URLs without reading complete media into JavaScript. */
import { useEffect, useState } from 'react'
import { fileMediaUrl, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { CanvasNodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasVideoFiles } from './face.ts'
import type { NS } from './locales.ts'

/** File preparation and resource failures remain distinguishable from pending playback. */
export type CanvasVideoFile = { readonly status: 'idle' | 'loading' } | { readonly status: 'failed'; readonly message: string } | { readonly status: 'ready'; readonly url: string }

/**
 * Prepare an exact version in the captured project, ignoring results from older scopes or selections.
 * @param files - compatible path provider and authorized resource hook.
 * @param node - recorded source node.
 * @param version - exact retained version; a removed version never falls back.
 * @param enabled - whether the containing editor can read its captured project.
 * @param t - locale-owned failure copy.
 * @param refresh - explicit retry counter.
 * @returns a stream URL or visible pending/failure state, without complete-file reads.
 */
export function useCanvasVideo(files: CanvasVideoFiles, node: CanvasNodeId, version: { readonly id?: VersionId; readonly path?: string } | undefined, enabled: boolean, t: PropsLocale<typeof NS>['t'], refresh = 0): CanvasVideoFile {
  const { scope, videoPath, useResource, sessionId } = files
  const key = JSON.stringify([scope.directory, scope.episode, node, version?.id, version?.path, refresh])
  const [prepared, setPrepared] = useState<{ readonly key: string; readonly path?: string; readonly error?: string }>()
  useEffect(() => {
    if (!enabled || version?.id === undefined || version.path === undefined) return
    let live = true
    setPrepared({ key })
    void videoPath(node, version.id, scope).then((reply) => {
      if (live) setPrepared(reply?.ok === true ? { key, path: reply.value } : { key, error: reply?.error.message ?? t('audio.localUnavailable') })
    }, (error: unknown) => { if (live) setPrepared({ key, error: error instanceof Error ? error.message : t('video.previewFailed') }) })
    return () => { live = false }
  }, [enabled, key, node, version?.id, version?.path, videoPath, scope, t])
  const current = enabled && prepared?.key === key ? prepared : undefined
  const resource = useResource<'file'>(current?.path === undefined ? '' : sessionFileAddress(sessionId, current.path))
  if (!enabled || version?.id === undefined || version.path === undefined) return { status: 'idle' }
  if (current?.error !== undefined) return { status: 'failed', message: current.error }
  if (resource.status === 'failed' || (resource.status === 'live' && resource.value === undefined)) return { status: 'failed', message: t('video.previewFailed') }
  if (current?.path === undefined || resource.status !== 'live' || resource.value === undefined) return { status: 'loading' }
  const url = fileMediaUrl(window.document.baseURI, resource.value.absolutePath)
  return url === undefined ? { status: 'failed', message: t('video.previewFailed') }
    : { status: 'ready', url: `${url}&version=${encodeURIComponent(resource.value.version)}` }
}
