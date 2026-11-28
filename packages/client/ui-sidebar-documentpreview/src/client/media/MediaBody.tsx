/** Audio/video files rendered through the authenticated ranged file route. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { fileMediaUrl, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { hostFileOf, type SessionFile } from '../rpc.ts'
import type {} from './locales.ts'
import css from './MediaBody.module.css'

const MEDIA_TYPES = {
  mp3: ['audio', 'audio/mpeg'],
  wav: ['audio', 'audio/wav'],
  flac: ['audio', 'audio/flac'],
  ogg: ['audio', 'audio/ogg'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  opus: ['audio', 'audio/ogg'],
  wma: ['audio', 'audio/x-ms-wma'],
  mp4: ['video', 'video/mp4'],
  mov: ['video', 'video/quicktime'],
  webm: ['video', 'video/webm'],
  m4v: ['video', 'video/x-m4v'],
  mkv: ['video', 'video/x-matroska'],
  avi: ['video', 'video/x-msvideo'],
  wmv: ['video', 'video/x-ms-wmv'],
  flv: ['video', 'video/x-flv'],
} as const

type MediaType = typeof MEDIA_TYPES[keyof typeof MEDIA_TYPES]

/** Media file metadata lookup supplied by the registration. */
export interface MediaBodyInjected {
  /** Read freshness and the Host absolute path for one media file. */
  readonly statFile: (file: SessionFile, signal: AbortSignal) => Promise<RemoteResult<WorkspaceFileStat>>
}

/** Standard document props plus the media renderer's dictionary. */
export type MediaBodyProps = DocumentPreviewProps & PropsLocale<'sidebarMedia'> & MediaBodyInjected

/**
 * Resolve a supported filename to its player kind and Blob media type.
 * @param path - decoded workspace file path.
 * @returns the media kind and MIME type, or undefined for an unregistered suffix.
 */
export function mediaTypeOf(path: string): MediaType | undefined {
  const normalized = path.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  const extension = name.slice(dot + 1) as keyof typeof MEDIA_TYPES
  return MEDIA_TYPES[extension]
}

/**
 * Resolve the current file version and present it through `/api/file`; the
 * browser issues range requests instead of the preview retaining media bytes.
 * @param props - renderer loading request, resource identity, file metadata lookup, and locale.
 * @returns a player contained by the document pane.
 */
export function MediaBody(props: MediaBodyProps): ReactNode {
  const { content, resourceAddress, statFile, t } = props
  const path = useMemo(() => hostFileOf(resourceAddress).path, [resourceAddress])
  const media = mediaTypeOf(path)
  const request = content.kind === 'renderer' ? content : undefined
  const revision = request?.revision
  const [view, setView] = useState<{ readonly revision: number; readonly url?: string; readonly failed?: boolean }>()
  const [playbackFailure, setPlaybackFailure] = useState<{ readonly revision: number; readonly url: string }>()
  const current = revision !== undefined && view?.revision === revision ? view : undefined

  useEffect(() => {
    if (request === undefined || media === undefined || revision === undefined) return
    const controller = new AbortController()
    const fail = (): void => {
      if (controller.signal.aborted) return
      setView({ revision, failed: true })
      request.failed()
    }
    void statFile(hostFileOf(resourceAddress), controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!result.ok) {
        fail()
        return
      }
      const base = fileMediaUrl(document.baseURI, result.value.absolutePath)
      if (base === undefined) {
        fail()
        return
      }
      const url = `${base}&v=${encodeURIComponent(result.value.version)}`
      setView({ revision, url })
      request.loaded(result.value.version)
    }, fail)
    return () => { controller.abort() }
  }, [revision, resourceAddress, media, statFile])

  if (request === undefined || media === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (current?.url === undefined) {
    return current?.failed === true
      ? <p className={css.status} role="alert">{t('failed')}</p>
      : <p className={css.status}>{t('loading')}</p>
  }
  const url = current.url
  if (playbackFailure?.revision === request.revision && playbackFailure.url === url) {
    return <p className={css.status} role="alert">{t('failed')}</p>
  }
  const label = t('preview', { name: pathPartsOf(path).name })
  return <div className={css.frame} data-media-preview>
    {media[0] === 'audio'
      ? <audio
        className={`${css.player} ${css.audio}`} controls src={url} aria-label={label}
        onError={() => { setPlaybackFailure({ revision: request.revision, url }) }}
      />
      : <video
        className={css.player} controls src={url} aria-label={label}
        onError={() => { setPlaybackFailure({ revision: request.revision, url }) }}
      />}
  </div>
}
