/** Video node operations use exact retained versions and the same local editor as Agent tools. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNode, CanvasNodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { LocalMediaEditResult } from '@deepseek-ai/dsh-api-remotes/client'
import { fileMediaUrl, resolveWorkspacePath, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { CanvasBodyProps } from './CanvasBody.tsx'
import type { CanvasInjected, CanvasVideoFiles } from './face.ts'
import { useCanvasVideo } from './video-file.ts'
import css from './Inspector.module.css'

/** Captured scope, file resources, and actions bound by the canvas owner. */
export type VideoLocalServices = CanvasVideoFiles &
  Pick<CanvasInjected, 'importVideo'> & {
    readonly editMedia: NonNullable<CanvasInjected['editMedia']>
    readonly reload: () => Promise<void>
    readonly locate: (node: CanvasNodeId) => void
    readonly previewChanged?: (node: CanvasNodeId, version: VersionId | undefined) => void
  }

type Props = VideoLocalServices & Pick<CanvasBodyProps, 't'> & { readonly node: CanvasNode; readonly enabled: boolean }
const operations = {
  extract_audio: 'video.extractAudio',
  first_frame: 'video.firstFrame',
  last_frame: 'video.lastFrame',
  refresh_tail: 'video.refreshTail',
} as const

/**
 * Audition candidates without adopting them, extract local media, refresh exact-source tails,
 * and download the original version. Preview streaming avoids complete-file byte caps.
 * @param props - node, captured scope, current availability, file resources, and shared actions.
 * @returns video preview, candidate selector, local actions, and recoverable outcomes.
 */
export function VideoLocalControls({
  node,
  enabled,
  scope,
  editMedia,
  videoPath,
  importVideo,
  reload,
  locate,
  previewChanged,
  useResource,
  sessionId,
  t,
}: Props) {
  const [selected, setSelected] = useState<VersionId | undefined>(() => node.activeVersion ?? node.versions?.at(-1)?.id)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState<keyof typeof operations | 'upload'>()
  const [notice, setNotice] = useState<{
    readonly key: 'audio.localFailed' | 'audio.localUnknown' | 'audio.localUnavailable' | 'audio.localRefreshFailed'
    readonly message?: string
  }>()
  const [result, setResult] = useState<LocalMediaEditResult>()
  const picker = useRef<HTMLInputElement>(null)
  const upload = useRef<AbortController>()
  const actionScope = `${scope.directory}/${scope.episode}/${node.id}`
  const currentScope = useRef<string | undefined>(actionScope)
  currentScope.current = actionScope
  useEffect(() => {
    currentScope.current = actionScope
    setBusy(undefined)
    setNotice(undefined)
    setResult(undefined)
    return () => {
      currentScope.current = undefined
      upload.current?.abort()
      upload.current = undefined
    }
  }, [actionScope])
  const version = node.versions?.find(item => item.id === selected)
  useEffect(() => {
    previewChanged?.(node.id, selected)
  }, [previewChanged, node.id, selected])
  useEffect(() => {
    const latest = node.versions?.at(-1)
    if (selected === undefined && latest !== undefined) setSelected(latest.id)
  }, [selected, node.versions])
  const preview = useCanvasVideo({ scope, videoPath, useResource, sessionId }, node.id, version, enabled, t, refresh)
  const original = useResource<'file'>(
    !enabled || version?.path === undefined
      ? ''
      : sessionFileAddress(sessionId, resolveWorkspacePath(scope.directory, version.path)),
  )
  const url = preview.status === 'ready' ? preview.url : undefined
  const originalUrl =
    original.status !== 'live' || original.value === undefined
      ? undefined
      : fileMediaUrl(window.document.baseURI, original.value.absolutePath)
  const [playbackFailed, setPlaybackFailed] = useState<string>()
  const save = async (operation: keyof typeof operations): Promise<void> => {
    if (!enabled || version?.path === undefined) return
    setBusy(operation)
    setNotice(undefined)
    setResult(undefined)
    let acknowledged = false
    try {
      const reply = await editMedia({
        scope,
        node: node.id,
        version: version.id,
        operation,
        title: t('video.resultTitle', { title: node.title, operation: t(operations[operation]) }),
      })
      if (currentScope.current !== actionScope) return
      if (reply === undefined) setNotice({ key: 'audio.localUnavailable' })
      else if (!reply.ok)
        setNotice({
          key: reply.error.code === 'media/edit' ? 'audio.localFailed' : 'audio.localUnknown',
          message:
            reply.error.code === 'media/edit' && reply.error.details.path !== undefined
              ? t('video.retainedFile', { message: reply.error.message, path: reply.error.details.path })
              : reply.error.message,
        })
      else {
        acknowledged = true
        setResult(reply.value)
        await reload()
      }
    } catch (error: unknown) {
      if (currentScope.current === actionScope)
        setNotice({
          key: acknowledged ? 'audio.localRefreshFailed' : 'audio.localUnknown',
          ...(error instanceof Error ? { message: error.message } : {}),
        })
    } finally {
      if (currentScope.current === actionScope) setBusy(undefined)
    }
  }
  const importFile = async (file: File): Promise<void> => {
    if (!enabled || busy !== undefined || importVideo === undefined) return
    const controller = new AbortController()
    upload.current = controller
    setBusy('upload')
    setNotice(undefined)
    setResult(undefined)
    let acknowledged = false
    try {
      const reply = await importVideo(node.id, scope, file, controller.signal)
      if (currentScope.current !== actionScope) return
      if (reply === undefined) setNotice({ key: 'audio.localUnavailable' })
      else if (!reply.ok)
        setNotice({
          key: reply.error.code === 'media/edit' ? 'audio.localFailed' : 'audio.localUnknown',
          message:
            reply.error.code === 'media/edit' && reply.error.details.path !== undefined
              ? t('video.retainedFile', { message: reply.error.message, path: reply.error.details.path })
              : reply.error.message,
        })
      else {
        acknowledged = true
        setResult(reply.value)
        await reload()
      }
    } catch (error: unknown) {
      if (currentScope.current === actionScope)
        setNotice({
          key: acknowledged ? 'audio.localRefreshFailed' : 'audio.localUnknown',
          ...(error instanceof Error ? { message: error.message } : {}),
        })
    } finally {
      if (currentScope.current === actionScope) {
        upload.current = undefined
        setBusy(undefined)
      }
    }
  }
  return (
    <section className={css.section} aria-label={t('video.localActions')}>
      <span className={css.sectionTitle}>{t('video.localActions')}</span>
      <label className={css.field}>
        <span>{t('video.sourceVersion')}</span>
        <select
          className={css.input}
          disabled={!enabled || busy !== undefined}
          value={version?.id ?? ''}
          onChange={(event) => {
            const picked = node.versions?.find(item => item.id === event.target.value)
            if (picked !== undefined) setSelected(picked.id)
          }}
        >
          {version === undefined && (
            <option value="" disabled>
              {t(selected === undefined ? 'video.noVersion' : 'audio.versionMissing')}
            </option>
          )}
          {(node.versions ?? []).map((item, index) => (
            <option key={item.id} value={item.id}>
              {t('inspector.versionLabel', { n: index + 1 })} ·{' '}
              {t(item.id === node.activeVersion ? 'video.adopted' : 'media.candidate')}
            </option>
          ))}
        </select>
      </label>
      {url !== undefined && playbackFailed !== url ? (
        <video
          className={css.videoPreview}
          src={url}
          controls
          preload="metadata"
          onError={() => {
            setPlaybackFailed(url)
          }}
        />
      ) : (
        <p
          className={css.empty}
          role={preview.status === 'failed' || (playbackFailed === url && url !== undefined) ? 'alert' : 'status'}
        >
          {t(
            version === undefined
              ? selected === undefined
                ? 'video.empty'
                : 'audio.versionMissing'
              : preview.status === 'failed' || (playbackFailed === url && url !== undefined)
                ? 'video.previewFailed'
                : 'media.loading',
          )}
        </p>
      )}
      {preview.status === 'failed' && <p className={css.notice}>{preview.message}</p>}
      {(preview.status === 'failed' || (url !== undefined && playbackFailed === url)) && (
        <Button
          size="sm"
          variant="outline"
          disabled={!enabled || busy !== undefined}
          onClick={() => {
            setPlaybackFailed(undefined)
            setRefresh(value => value + 1)
          }}
        >
          {t('video.retryPreview')}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={originalUrl === undefined || !enabled}
        onClick={() => {
          if (originalUrl === undefined) return
          const anchor = window.document.createElement('a')
          anchor.href = originalUrl
          anchor.download = version?.path?.split(/[/\\]/u).at(-1) ?? 'video.mp4'
          anchor.click()
        }}
      >
        {t('video.download')}
      </Button>
      {importVideo !== undefined && (
        <>
          <input
            ref={picker}
            type="file"
            hidden
            accept="video/*"
            aria-label={t('video.upload')}
            disabled={!enabled || busy !== undefined}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) void importFile(file)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!enabled || busy !== undefined}
            onClick={() => {
              picker.current?.click()
            }}
          >
            {t('video.upload')}
          </Button>
        </>
      )}
      <p className={css.empty}>{t('video.localHint')}</p>
      {(Object.keys(operations) as (keyof typeof operations)[]).map(operation => (
        <Button
          key={operation}
          size="sm"
          variant="outline"
          disabled={
            !enabled ||
            busy !== undefined ||
            version?.path === undefined ||
            (operation === 'refresh_tail' && node.activeVersion !== version.id)
          }
          onClick={() => {
            void save(operation)
          }}
        >
          {t(operations[operation])}
        </Button>
      ))}
      {busy !== undefined && (
        <p className={css.empty} role="status">
          {busy === 'upload' ? t('video.uploading') : t('video.processing', { operation: t(operations[busy]) })}
        </p>
      )}
      {notice !== undefined && (
        <p className={css.notice} role="alert">
          {t(notice.key, { message: notice.message ?? '' })}
        </p>
      )}
      {result !== undefined && (
        <div className={css.section} role="status">
          <p className={css.empty}>{t('video.saved')}</p>
          <Button
            size="sm"
            onClick={() => {
              locate(result.node)
            }}
          >
            {t('video.locateResult')}
          </Button>
        </div>
      )}
    </section>
  )
}
