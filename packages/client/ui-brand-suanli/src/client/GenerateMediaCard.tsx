/** Inline card for one generate_video or generate_music call: progress, players for the saved files, and follow-up actions. */
import { useCallback, useEffect, useState } from 'react'
import {
  Button, IconCheckOutlineRegular, IconCopyOutlineRegular, IconDownloadOutlineRegular, IconRefreshOutlineRegular,
  TextShimmer, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { mediaResultOf, type MediaResult, type MediaResultItem } from './media-result.ts'
import css from './GenerateMediaCard.module.css'

/** Reads one saved file of the call's Session as a Blob. */
export type MediaLoader = (path: string, mediaType: string, signal: AbortSignal) => Promise<Blob>

/** Props the keyed toolview entry receives. */
export type GenerateMediaCardProps = ToolCallViewProps & { loadMedia: MediaLoader; t: TranslateNS<'gatewayStatus'> }

/**
 * Render the call while it runs, its players once it settles, or its text when it failed.
 * @param props - toolview owner props, the Session file loader, and this plugin's copy.
 * @returns the card.
 */
export function GenerateMediaCard(props: GenerateMediaCardProps) {
  const { t } = props
  const kind = props.toolName === 'generate_music' ? 'music' : 'video'
  if (props.phase !== 'result') {
    return <div className={css.card}><TextShimmer active><span className={css.title}>{t(`${kind}.generating`)}</span></TextShimmer></div>
  }
  const { block } = props
  const result = block.isError ? null : mediaResultOf(block.meta)
  if (result === null) {
    const text = block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
    return <div className={css.card}>
      {block.isError && <p className={css.title}>{t(`${kind}.failed`)}</p>}
      {text !== '' && <p className={css.detail}>{text}</p>}
    </div>
  }
  if (result.status === 'cancelled') return <div className={css.card}><p className={css.title}>{t('image.cancelled')}</p></div>
  return <GeneratedMedia result={result} kind={kind} props={props} />
}

/**
 * The settled card body; separate so its hooks run only for a generated result.
 * @param root - the generated result, which tool made it, and the card props.
 * @returns the players with their actions.
 */
function GeneratedMedia({ result, kind, props }: { result: MediaResult; kind: 'video' | 'music'; props: GenerateMediaCardProps }) {
  const { t, inputActions } = props
  const copy = useClipboardCopy(result.prompt)
  const facts = [result.modelLabel, ...result.parameters.map(item => item.value)].join(' · ')
  const regenerate = useCallback(() => {
    inputActions.setDraft(t(`${kind}.regenerate-request`, { prompt: result.prompt, settings: facts }))
    inputActions.submit()
  }, [inputActions, t, kind, result.prompt, facts])
  return <div className={css.card}>
    <p className={css.title}>{t(`${kind}.generated`)}</p>
    <p className={css.detail}>{facts}</p>
    {result.media.map(item => <MediaPlayer key={item.path} item={item} props={props} />)}
    <div className={css.actions}>
      <Button size="sm" icon={copy.copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />} onClick={copy.onCopy}>
        {copy.copied ? t('image.copied') : t('image.copy-prompt')}
      </Button>
      <Button size="sm" icon={<IconRefreshOutlineRegular />} onClick={regenerate}>{t('image.regenerate')}</Button>
    </div>
  </div>
}

/** Where one file's bytes are: not read yet, being read, ready as an object URL, or unreadable. */
type Loaded = { readonly state: 'idle' | 'loading' | 'failed' } | { readonly state: 'ready'; readonly url: string }

/**
 * One saved file: a play button that reads it on demand, then the native player with fullscreen and download.
 * @param root - the saved file and the card props.
 * @returns the player row.
 */
function MediaPlayer({ item, props }: { item: MediaResultItem; props: GenerateMediaCardProps }) {
  const { t, loadMedia, openFile } = props
  const [loaded, setLoaded] = useState<Loaded>({ state: 'idle' })
  const url = loaded.state === 'ready' ? loaded.url : undefined
  useEffect(() => () => { if (url !== undefined) URL.revokeObjectURL(url) }, [url])
  const load = useCallback(() => {
    setLoaded({ state: 'loading' })
    void loadMedia(item.path, item.mediaType, AbortSignal.timeout(120_000)).then(
      (blob) => { setLoaded({ state: 'ready', url: URL.createObjectURL(blob) }) },
      () => { setLoaded({ state: 'failed' }) },
    )
  }, [loadMedia, item.path, item.mediaType])
  const name = baseName(item.path)
  const video = item.mediaType.startsWith('video/')
  return <>
    {url !== undefined && (video
      ? <video className={css.video} src={url} controls autoPlay playsInline aria-label={name} />
      : <audio className={css.audio} src={url} controls autoPlay aria-label={name} />)}
    {loaded.state === 'failed' && <p className={css.detail}>{t('media.unreadable', { path: item.path })}</p>}
    <div className={css.actions}>
      {url === undefined && loaded.state !== 'failed' && (
        <Button size="sm" variant="primary" disabled={loaded.state === 'loading'} onClick={load}>
          {loaded.state === 'loading' ? t('media.loading') : t(video ? 'media.play-video' : 'media.play-audio')}
        </Button>
      )}
      {url !== undefined && (
        <Button size="sm" icon={<IconDownloadOutlineRegular />} onClick={() => { download(url, name) }}>{t('image.download')}</Button>
      )}
      <Button size="sm" onClick={() => { openFile(item.path) }}>{t('media.open')}</Button>
    </div>
  </>
}

/**
 * @param url - object URL of the file.
 * @param name - suggested file name.
 */
function download(url: string, name: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
}

/**
 * @param path - saved file path.
 * @returns its last segment.
 */
function baseName(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path
}
