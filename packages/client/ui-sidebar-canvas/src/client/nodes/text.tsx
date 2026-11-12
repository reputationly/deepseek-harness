/** Text, script, storyboard, and timeline cards: what the node states, briefly. */
import type { ReactNode } from 'react'
import type { NodeProps } from '@xyflow/react'
import { scriptPreview, scriptScenes, storyboardCardView } from '../model/cards.ts'
import type { CanvasFlowNode } from '../flow.ts'
import { NodeCard, shownVersion } from './shared.tsx'
import css from '../CanvasFlow.module.css'

/** A plain note. */
export function TextNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  return <NodeCard data={data} selected={selected} className={css.text}>
    <p className={css.textBody}>{shownVersion(data.node).text}</p>
  </NodeCard>
}

/** A script: its scene headings and the first lines of the body. */
export function ScriptNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  const { node, t } = data
  const text = shownVersion(node).text ?? ''
  const scenes = scriptScenes(text)
  return <NodeCard data={data} selected={selected} className={css.text}>
    <div className={css.sceneList}>
      <span className={css.sectionLabel}>{t('script.scenes')}</span>
      {scenes.length === 0
        ? <p className={css.textBody}>{scriptPreview(text)}</p>
        : scenes.map(scene => <div key={scene.number} className={css.sceneRow}>
          <span className={css.sceneNumber}>{scene.number}</span>
          <span className={css.sceneTitle}>{scene.title}</span>
        </div>)}
    </div>
    <p className={css.textBody}>{scriptPreview(text)}</p>
  </NodeCard>
}

/** A storyboard: a small shot table and the segmentation summary. */
export function StoryboardNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  const { node } = data
  const view = storyboardCardView(node)
  return <NodeCard data={data} selected={selected} className={css.storyboardCard}>
    <div className={css.shotTable} role="table" aria-label={node.title}>
      {view.rows.map(row => <div key={row.id} className={css.shotRow} role="row">
        <span className={css.shotTitle}>{row.title}</span>
        <span className={css.shotSize}>{row.shotSize}</span>
        <span className={css.shotSeconds}>{row.seconds}s</span>
      </div>)}
    </div>
    <p className={css.summary}>{view.summary}</p>
  </NodeCard>
}

/** A finished cut: its clip count and duration. */
export function TimelineNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  const { node, t } = data
  const duration = (node.timeline?.durationMs ?? 0) / 1000
  return <NodeCard data={data} selected={selected} className={css.text}>
    <p className={css.textBody}>{t('timeline.clips', { clips: node.timeline?.exports.length ?? 0, duration: duration.toFixed(1) })}</p>
  </NodeCard>
}
