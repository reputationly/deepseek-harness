/** Parts every node card shares: the frame, media reads, the version bar, and the status layer. */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Handle, Position } from '@xyflow/react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNode, NodeStatus } from '@deepseek-ai/dsh-canvas/client'
import type { CanvasFlowNode } from '../flow.ts'
import { cardState, versionChoices } from '../model/cards.ts'
import type { ReadCanvasFile } from '../face.ts'
import css from '../CanvasFlow.module.css'

/** Content of the version a node currently shows. */
export function shownVersion(node: CanvasNode): { path?: string; text?: string; durationMs?: number; shots?: unknown } {
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

/** Bytes of one media file read into an object URL. */
export type Media =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly url: string; readonly bytes: Uint8Array<ArrayBuffer> }

/** Object URL of one media file, read while `wanted`. */
export function useMedia(path: string | undefined, wanted: boolean, readFile: ReadCanvasFile): Media {
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
      setMedia({ status: 'ready', url, bytes: file.data })
    })
    return () => {
      lifetime.abort()
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [path, wanted, readFile])
  return media
}

/** Loading and failure feedback inside a media area. */
export function MediaStatus({ media, loading, failed }: { media: Media; loading: string; failed: string }): ReactNode {
  if (media.status === 'failed') return <span className={css.mediaStatus} role="alert">{failed}</span>
  return <span className={css.mediaStatus} role="status" aria-label={loading}><StateDot state="ongoing" size={20} /></span>
}

/** Elapsed time of a running job, ticking while the card is mounted. */
function useElapsed(status: NodeStatus | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  const running = status?.state === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { setNow(Date.now()) }, 500)
    return () => { clearInterval(timer) }
  }, [running])
  const state = cardState(status, now)
  return state.kind === 'running' ? state.elapsedMs : 0
}

/** Version bar under a node that has more than one version. */
function VersionBar({ data }: { data: CanvasFlowNode['data'] }): ReactNode {
  const { node, t, edit } = data
  const choices = versionChoices(node)
  if (choices.length === 0) return undefined
  return <div className={css.versionBar} role="group" aria-label={t('version.switch', { label: '' })}>
    {choices.map(choice => <button
      key={choice.id}
      type="button"
      className={clsx(css.versionChip, choice.active && css.versionChipActive, 'nodrag')}
      aria-pressed={choice.active}
      title={t('version.switch', { label: choice.label })}
      onClick={(event) => {
        event.stopPropagation()
        if (choice.active) return
        void edit([{ op: 'set_version', node: node.id, version: choice.id }])
      }}
    >{choice.label}</button>)}
  </div>
}

/** Overlay that reports a node's generation state. */
function StatusLayer({ data }: { data: CanvasFlowNode['data'] }): ReactNode {
  const { node, t, edit } = data
  const state = cardState(node.status, Date.now())
  const elapsed = useElapsed(node.status)
  if (state.kind === 'idle') return undefined
  const retry = state.kind === 'failed' && state.retryable && node.gen !== undefined
  return <div className={clsx(css.statusLayer, state.kind === 'failed' && css.statusFailed)} role="status">
    {state.kind === 'queued' && <span className={css.statusText}>{t('status.queued')}</span>}
    {state.kind === 'running' && <span className={css.statusText}>
      <StateDot state="ongoing" size={16} />{t('status.running')} · {t('status.elapsed', { seconds: Math.round(elapsed / 1000) })}
    </span>}
    {state.kind === 'failed' && <span className={css.statusText} role="alert">
      {t('status.failed', { message: state.error })}
    </span>}
    {retry && <Button
      size="sm" variant="outline" className="nodrag"
      onClick={(event) => {
        event.stopPropagation()
        /* v8 ignore next -- retry renders only for a node that has a generation */
        void edit([{ op: 'set_gen', node: node.id, gen: { params: node.gen?.params ?? {} } }])
      }}
    >{t('status.retry')}</Button>}
  </div>
}

/** Card frame that also draws the version bar and the status layer of its node. */
export function NodeCard(props: {
  readonly data: CanvasFlowNode['data']
  readonly selected: boolean
  readonly className?: string | undefined
  readonly children: ReactNode
}): ReactNode {
  const { data, selected } = props
  const { node } = data
  return <div className={clsx(css.card, selected && css.selected, props.className)} data-canvas-node>
    <Handle type="target" position={Position.Left} className={css.handle} />
    {props.children}
    <VersionBar data={data} />
    <div className={css.caption} title={node.title}>{node.title}</div>
    <StatusLayer data={data} />
    <Handle type="source" position={Position.Right} className={css.handle} />
  </div>
}
