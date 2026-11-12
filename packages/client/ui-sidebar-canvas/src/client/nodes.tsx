/** Node cards of the canvas flow: media, text, and group frames. */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Button, IconPlayOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNode } from '@deepseek-ai/dsh-canvas/client'
import type { CanvasFlowNode } from './flow.ts'
import type { ReadCanvasFile } from './face.ts'
import css from './CanvasFlow.module.css'

/** Content of the version a node currently shows. */
function shownVersion(node: CanvasNode): { path?: string; text?: string } {
  const versions = node.versions ?? []
  return versions.find(version => version.id === node.activeVersion) ?? versions.at(-1) ?? {}
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
}

/**
 * Media type a Blob of this file is given.
 * @param path - media file path.
 * @returns the type for a known extension, or an empty type the browser sniffs.
 */
export function mediaType(path: string): string {
  return MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? ''
}

type Media = { readonly status: 'idle' | 'loading' | 'failed' } | { readonly status: 'ready'; readonly url: string }

/** Object URL of one media file, read while `wanted`. */
function useMedia(path: string | undefined, wanted: boolean, readFile: ReadCanvasFile): Media {
  const [media, setMedia] = useState<Media>({ status: 'idle' })
  useEffect(() => {
    if (path === undefined || !wanted) return
    const lifetime = new AbortController()
    let url: string | undefined
    setMedia({ status: 'loading' })
    void readFile(path, lifetime.signal).then((file) => {
      if (lifetime.signal.aborted) return
      if (!file.ok) { setMedia({ status: 'failed' }); return }
      url = URL.createObjectURL(new Blob([file.data], { type: mediaType(path) }))
      setMedia({ status: 'ready', url })
    })
    return () => {
      lifetime.abort()
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [path, wanted, readFile])
  return media
}

/** Card frame: both connection handles, the content, and the title caption. */
function Card({ title, selected, className, children }: {
  title: string
  selected: boolean
  className?: string | undefined
  children: ReactNode
}): ReactNode {
  return <div className={clsx(css.card, selected && css.selected, className)} data-canvas-node>
    <Handle type="target" position={Position.Left} className={css.handle} />
    {children}
    <div className={css.caption} title={title}>{title}</div>
    <Handle type="source" position={Position.Right} className={css.handle} />
  </div>
}

/** Loading and failure feedback inside a media area. */
function MediaStatus({ media, loading, failed }: { media: Media; loading: string; failed: string }): ReactNode {
  if (media.status === 'failed') return <span className={css.mediaStatus} role="alert">{failed}</span>
  return <span className={css.mediaStatus} role="status" aria-label={loading}><StateDot state="ongoing" size={20} /></span>
}

/** An image, read when the card mounts. */
export function ImageNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  const { node, readFile, t } = data
  const media = useMedia(shownVersion(node).path, true, readFile)
  return <Card title={node.title} selected={selected}>
    <div className={css.media}>
      {media.status === 'ready'
        ? <img className={css.image} src={media.url} alt={node.title} draggable={false} />
        : <MediaStatus media={media} loading={t('media.loading')} failed={t('media.failed')} />}
    </div>
  </Card>
}

/** A video or audio file, read once the user asks to play it. */
function PlayableNode({ data, selected, kind }: NodeProps<CanvasFlowNode> & { kind: 'video' | 'audio' }): ReactNode {
  const { node, readFile, t } = data
  const [wanted, setWanted] = useState(false)
  const media = useMedia(shownVersion(node).path, wanted, readFile)
  let content: ReactNode
  if (media.status === 'ready') {
    content = kind === 'video'
      ? <video className={clsx(css.image, 'nodrag')} src={media.url} controls autoPlay />
      : <audio className={clsx(css.audio, 'nodrag')} src={media.url} controls autoPlay />
  } else if (media.status === 'idle') {
    content = <Button variant="outline" size="sm" className="nodrag" aria-label={t(`${kind}.play`)}
      icon={<IconPlayOutlineRegular />} onClick={() => { setWanted(true) }}>{t(`${kind}.play`)}</Button>
  } else {
    content = <MediaStatus media={media} loading={t('media.loading')} failed={t('media.failed')} />
  }
  return <Card title={node.title} selected={selected}><div className={css.media}>{content}</div></Card>
}

/** A video card. */
export function VideoNode(props: NodeProps<CanvasFlowNode>): ReactNode {
  return <PlayableNode {...props} kind="video" />
}

/** An audio card. */
export function AudioNode(props: NodeProps<CanvasFlowNode>): ReactNode {
  return <PlayableNode {...props} kind="audio" />
}

/** A text note. */
export function TextNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  return <Card title={data.node.title} selected={selected} className={css.text}>
    <p className={css.textBody}>{shownVersion(data.node).text}</p>
  </Card>
}

/** A group frame around its members. */
export function GroupNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  return <div className={clsx(css.group, selected && css.selected)} data-canvas-group>
    <Handle type="target" position={Position.Left} className={css.handle} />
    <div className={css.groupTitle} title={data.node.title}>{data.node.title}</div>
    <Handle type="source" position={Position.Right} className={css.handle} />
  </div>
}

/** Card component of every node type. */
export const NODE_TYPES = { image: ImageNode, video: VideoNode, audio: AudioNode, text: TextNode, frame: GroupNode }
