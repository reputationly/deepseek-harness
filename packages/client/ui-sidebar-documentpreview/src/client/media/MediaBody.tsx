/** Complete audio/video bytes rendered with the browser's native player. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { hostFileOf } from '../rpc.ts'
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

/** Standard document props plus the media renderer's dictionary. */
export type MediaBodyProps = DocumentPreviewProps & PropsLocale<'sidebarMedia'>

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
 * Present complete media bytes in a native audio or video player.
 * @param props - document bytes, resource identity, and locale.
 * @returns a player contained by the document pane.
 */
export function MediaBody(props: MediaBodyProps): ReactNode {
  const { content, resourceAddress, t } = props
  const path = useMemo(() => hostFileOf(resourceAddress).path, [resourceAddress])
  const media = mediaTypeOf(path)
  const data = content.kind === 'bytes' ? content.data : undefined
  const [failed, setFailed] = useState(false)
  const [source, setSource] = useState<{ readonly data: Uint8Array<ArrayBuffer>; readonly url?: string }>()
  useEffect(() => {
    setFailed(false)
    if (data === undefined || media === undefined) {
      setSource(undefined)
      return
    }
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([data], { type: media[1] }))
      setSource({ data, url })
    } catch {
      setSource({ data })
    }
    return () => { if (url !== undefined) URL.revokeObjectURL(url) }
  }, [data, media])

  if (data === undefined || media === undefined) {
    return <p className={css.status} role="alert">{t('unsupported')}</p>
  }
  if (source?.data !== data) return <p className={css.status}>{t('loading')}</p>
  if (failed || source.url === undefined) return <p className={css.status} role="alert">{t('failed')}</p>
  const label = t('preview', { name: pathPartsOf(path).name })
  return <div className={css.frame} data-media-preview>
    {media[0] === 'audio'
      ? <audio className={`${css.player} ${css.audio}`} controls src={source.url} aria-label={label} onError={() => { setFailed(true) }} />
      : <video className={css.player} controls src={source.url} aria-label={label} onError={() => { setFailed(true) }} />}
  </div>
}
