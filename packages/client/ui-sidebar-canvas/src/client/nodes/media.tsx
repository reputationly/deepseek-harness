/** Image, video, and audio cards: the media itself, its duration, and its segment badge. */
import { useCallback, useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import clsx from 'clsx'
import type { NodeProps } from '@xyflow/react'
import { Button, IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNode } from '@deepseek-ai/dsh-canvas/client'
import type { CanvasFlowNode } from '../flow.ts'
import type { ReadCanvasFile } from '../face.ts'
import { useCanvasVideo } from '../video-file.ts'
import { durationSeconds } from '../model/cards.ts'
import { MediaStatus, NodeCard, shownVersion, useMedia, type Media } from './shared.tsx'
import css from '../CanvasFlow.module.css'

/** Bars the audio card draws at most. */
const MAX_BARS = 400

/** Peaks of one decoded audio file, drawn as a waveform. */
function usePeaks(media: Media): readonly number[] | undefined {
  const [peaks, setPeaks] = useState<readonly number[]>()
  useEffect(() => {
    if (media.status !== 'ready') return
    let cancelled = false
    const isCancelled = (): boolean => cancelled
    const lifetime = { done: false }
    void (async () => {
      try {
        const context = new AudioContext()
        const buffer = await context.decodeAudioData(media.bytes.slice().buffer)
        await context.close()
        /* v8 ignore next -- the effect cleans up before a decode resolves only on unmount */
        if (isCancelled()) return
        const channel = buffer.getChannelData(0)
        const size = Math.max(1, Math.min(MAX_BARS, Math.floor(buffer.length / 512)))
        const step = Math.floor(channel.length / size)
        const buckets: number[] = []
        for (let index = 0; index < size; index += 1) {
          let peak = 0
          for (let sample = 0; sample < step; sample += 8) {
            /* v8 ignore next -- the bucket bounds keep every sample inside the channel */
            peak = Math.max(peak, Math.abs(channel[index * step + sample] ?? 0))
          }
          buckets.push(peak)
        }
        setPeaks(buckets)
      } catch (_undecodable: unknown) {
        if (!isCancelled()) setPeaks(undefined)
      } finally {
        lifetime.done = true
      }
    })()
    return () => {
      cancelled = true
    }
  }, [media])
  return peaks
}

/** Waveform canvas of one audio file. */
function Waveform({ peaks }: { peaks: readonly number[] }): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    if (element === null || peaks.length === 0) return
    const draw = (): void => {
      const width = element.clientWidth || 240
      const height = element.clientHeight || 40
      const ratio = window.devicePixelRatio || 1
      element.width = Math.ceil(width * ratio)
      element.height = Math.ceil(height * ratio)
      const context = element.getContext('2d')
      if (context === null) return
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, height)
      context.fillStyle = getComputedStyle(element).getPropertyValue('--dsw-alias-label-tertiary').trim()
      const bar = width / peaks.length
      peaks.forEach((peak, index) => {
        const size = Math.max(1, peak * height)
        context.fillRect(index * bar, (height - size) / 2, Math.max(1, bar - 1), size)
      })
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(element)
    window.addEventListener('resize', draw)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', draw)
    }
  }, [peaks])
  if (peaks.length === 0) return undefined
  return <canvas ref={canvas} className={css.waveform} aria-hidden="true" />
}

/** Duration badge under a media card. */
function DurationBadge({ node, t }: { node: CanvasNode; t: NodeProps<CanvasFlowNode>['data']['t'] }): ReactNode {
  const seconds = durationSeconds(shownVersion(node).durationMs)
  return seconds === undefined ? undefined : <span className={css.badge}>{t('badge.duration', { seconds })}</span>
}

/** Input state badges shared by image, video, and audio cards. */
function ChangeBadges({ node, t }: { node: CanvasNode; t: NodeProps<CanvasFlowNode>['data']['t'] }): ReactNode {
  return (
    <>
      {node.inputChanged === true && <span className={css.badge}>{t('badge.inputChanged')}</span>}
      {node.stale === true && <span className={css.badge}>{t('badge.stale')}</span>}
    </>
  )
}

/** An image card. */
export function ImageNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  const { node, readFile, t } = data
  const media = useMedia(shownVersion(node).path, true, readFile)
  return (
    <NodeCard data={data} selected={selected}>
      <div className={css.media}>
        {media.status === 'ready' ? (
          <img className={css.image} src={media.url} alt={node.title} draggable={false} />
        ) : (
          <MediaStatus media={media} loading={t('media.loading')} failed={t('media.failed')} />
        )}
      </div>
      <div className={css.badges}>
        <ChangeBadges node={node} t={t} />
        <DurationBadge node={node} t={t} />
      </div>
    </NodeCard>
  )
}

/** A video card: hover plays a muted preview; the segment badge names its place in the storyboard. */
export function VideoNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  return data.videoFiles === undefined ? (
    <ByteVideoNode data={data} selected={selected} />
  ) : (
    <StreamingVideoNode data={data} selected={selected} files={data.videoFiles} />
  )
}

/** Older injectors retain their byte reader; the production canvas supplies streaming resources. */
function ByteVideoNode({ data, selected }: Pick<NodeProps<CanvasFlowNode>, 'data' | 'selected'>): ReactNode {
  const { node, readFile, previewVideo, t } = data
  const version = shownVersion(node)
  const identity = JSON.stringify([node.id, version.id, version.path])
  const [wanted, setWanted] = useState(false)
  const [fallback, setFallback] = useState<string>()
  const [decodeFailure, setDecodeFailure] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const usingPreview = fallback === identity && previewVideo !== undefined && version.id !== undefined
  const reader = useCallback<ReadCanvasFile>(
    (path, signal) => {
      return usingPreview ? previewVideo(node.id, version.id, signal) : readFile(path, signal)
    },
    [usingPreview, previewVideo, node.id, version.id, readFile],
  )
  const media = useMedia(usingPreview ? 'preview.webm' : version.path, true, reader, refresh)
  const failed = media.status === 'failed' || (media.status === 'ready' && decodeFailure === media.url)
  const cannotDecode = (): void => {
    if (!usingPreview && previewVideo !== undefined && version.id !== undefined) setFallback(identity)
    else if (media.status === 'ready') setDecodeFailure(media.url)
  }
  const checkVideo = (event: SyntheticEvent<HTMLVideoElement>): void => {
    const video = event.currentTarget
    // A container can play its audio while silently ignoring an unsupported video track.
    if (video.videoWidth === 0 || video.videoHeight === 0) cannotDecode()
  }
  const badge = data.segmentBadge
  return (
    <NodeCard data={data} selected={selected}>
      <div
        className={css.media}
        onMouseEnter={() => {
          setWanted(true)
        }}
        onMouseLeave={() => {
          setWanted(false)
        }}
      >
        {failed ? (
          <div className={css.previewFailure} title={media.status === 'failed' ? media.message : undefined}>
            <span role="alert">{t('media.previewFailed')}</span>
            <Button
              size="sm"
              variant="outline"
              className="nodrag"
              onClick={() => {
                setDecodeFailure(undefined)
                setRefresh(value => value + 1)
              }}
            >
              {t('retry')}
            </Button>
          </div>
        ) : media.status === 'ready' ? (
          <video
            className={clsx(css.image, 'nodrag')}
            src={media.url}
            muted
            loop
            playsInline
            controls
            preload="metadata"
            autoPlay={wanted}
            onError={cannotDecode}
            onLoadedData={checkVideo}
            onCanPlay={checkVideo}
            onMouseEnter={(event) => {
              void event.currentTarget.play().catch((error: unknown) => {
                if (error instanceof DOMException && error.name === 'NotSupportedError') cannotDecode()
              })
            }}
            onMouseLeave={(event) => {
              event.currentTarget.pause()
            }}
          />
        ) : (
          <MediaStatus
            media={media}
            loading={t(usingPreview ? 'media.preparingPreview' : 'media.loading')}
            failed={t('media.failed')}
          />
        )}
      </div>
      <div className={css.badges}>
        <ChangeBadges node={node} t={t} />
        <DurationBadge node={node} t={t} />
        {/* v8 ignore next -- the segment badge shows only for a storyboard segment */}
        {badge === undefined ? undefined : <span className={css.badge}>{badge}</span>}
      </div>
    </NodeCard>
  )
}

/** Compatible previews stream only while the card is selected, hovered, or focused. */
function StreamingVideoNode({
  data,
  selected,
  files,
}: Pick<NodeProps<CanvasFlowNode>, 'data' | 'selected'> & {
  readonly files: NonNullable<CanvasFlowNode['data']['videoFiles']>
}): ReactNode {
  const { node, t } = data
  const [wanted, setWanted] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [decodeFailure, setDecodeFailure] = useState<string>()
  const media = useCanvasVideo(files, node.id, shownVersion(node), selected || wanted, t, refresh)
  const failed = media.status === 'failed' || (media.status === 'ready' && decodeFailure === media.url)
  const cannotDecode = (): void => {
    if (media.status === 'ready') setDecodeFailure(media.url)
  }
  const checkVideo = (event: SyntheticEvent<HTMLVideoElement>): void => {
    if (event.currentTarget.videoWidth === 0 || event.currentTarget.videoHeight === 0) cannotDecode()
  }
  return (
    <NodeCard data={data} selected={selected}>
      <div
        className={css.media}
        data-canvas-video-preview
        onMouseEnter={() => {
          setWanted(true)
        }}
        onMouseLeave={() => {
          setWanted(false)
        }}
        onFocusCapture={() => {
          setWanted(true)
        }}
        onBlurCapture={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
            setWanted(false)
        }}
      >
        {failed ? (
          <div className={css.previewFailure} title={media.status === 'failed' ? media.message : undefined}>
            <span role="alert">{t('media.previewFailed')}</span>
            <Button
              size="sm"
              variant="outline"
              className="nodrag"
              onClick={() => {
                setDecodeFailure(undefined)
                setRefresh(value => value + 1)
              }}
            >
              {t('retry')}
            </Button>
          </div>
        ) : media.status === 'ready' ? (
          <video
            className={clsx(css.image, 'nodrag')}
            src={media.url}
            muted
            loop
            playsInline
            controls
            preload="metadata"
            autoPlay={wanted}
            onError={cannotDecode}
            onLoadedData={checkVideo}
            onCanPlay={checkVideo}
            onMouseEnter={(event) => {
              void event.currentTarget.play().catch((error: unknown) => {
                if (error instanceof DOMException && error.name === 'NotSupportedError') cannotDecode()
              })
            }}
            onMouseLeave={(event) => {
              event.currentTarget.pause()
            }}
          />
        ) : media.status === 'idle' ? (
          <IconPlayOutlineRegular aria-hidden="true" />
        ) : (
          <MediaStatus media={media} loading={t('media.preparingPreview')} failed={t('media.failed')} />
        )}
      </div>
      <div className={css.badges}>
        <ChangeBadges node={node} t={t} />
        <DurationBadge node={node} t={t} />
        {data.segmentBadge === undefined ? undefined : <span className={css.badge}>{data.segmentBadge}</span>}
      </div>
    </NodeCard>
  )
}

/** An audio card: waveform, duration, and the line a voice node speaks. */
export function AudioNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  const { node, readFile, t } = data
  const [wanted, setWanted] = useState(false)
  const media = useMedia(shownVersion(node).path, true, readFile)
  const peaks = usePeaks(media)
  return (
    <NodeCard data={data} selected={selected}>
      <div className={css.mediaColumn}>
        {media.status === 'ready' ? (
          <Waveform peaks={peaks ?? []} />
        ) : (
          <MediaStatus media={media} loading={t('media.loading')} failed={t('media.failed')} />
        )}
        {media.status === 'ready' && (
          <audio className={clsx(css.audio, 'nodrag')} src={media.url} controls autoPlay={wanted} />
        )}
        {media.status !== 'ready' && (
          <Button
            variant="outline"
            size="sm"
            className="nodrag"
            aria-label={t('audio.play')}
            icon={<IconPlayOutlineRegular />}
            onClick={() => {
              setWanted(true)
            }}
          >
            {t('audio.play')}
          </Button>
        )}
        {/* v8 ignore next -- the spoken line shows only for speech nodes */}
        {node.gen !== undefined && node.gen.kind === 'speech' ? (
          <p className={css.line}>{node.gen.prompt}</p>
        ) : undefined}
      </div>
      <div className={css.badges}>
        <ChangeBadges node={node} t={t} />
        <DurationBadge node={node} t={t} />
      </div>
    </NodeCard>
  )
}
