/** A group frame around its members. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { groupScene } from '../model/cards.ts'
import type { CanvasFlowNode } from '../flow.ts'
import css from '../CanvasFlow.module.css'

/** A group frame: its title, scene number, and member count. */
export function GroupNode({ data, selected }: NodeProps<CanvasFlowNode>): ReactNode {
  const { node, t, members = 0 } = data
  const scene = groupScene(node)
  return <div className={clsx(css.group, selected && css.selected)} data-canvas-group>
    <Handle type="target" position={Position.Left} className={css.handle} />
    <div className={css.groupTitle} title={node.title}>
      {scene === undefined ? undefined : <span className={css.sceneBadge}>{scene}</span>}
      <span className={css.groupName}>{node.title}</span>
      {members === 0 ? undefined : <span className={css.memberCount}>{t('group.members', { count: members })}</span>}
    </div>
    <Handle type="source" position={Position.Right} className={css.handle} />
  </div>
}
