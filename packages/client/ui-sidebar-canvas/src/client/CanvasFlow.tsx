/** The canvas drawn as a flow: pan, zoom, drag, connect, group, and delete. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Background, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Button, IconFullscreenOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
  IconTrashOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasDocument, CanvasOperation } from '@deepseek-ai/dsh-canvas/client'
import {
  deleteOperations, flowEdges, flowNodes, keepSelection,
  type CanvasFlowEdge, type CanvasFlowNode, type CanvasNodeFace,
} from './flow.ts'
import { NODE_TYPES } from './nodes/index.ts'
import { CanvasRoleMenu } from './CanvasRoleMenu.tsx'
import { useGestures } from './useGestures.ts'
import type { EditHistory } from './model/history.ts'
import css from './CanvasFlow.module.css'

/** The document to draw and the calls its edits go through. */
export type CanvasFlowProps = CanvasNodeFace & {
  readonly document: CanvasDocument
  readonly edit: (operations: readonly CanvasOperation[]) => Promise<void>
  readonly reload: () => Promise<void>
  /** Reports the selected node, or undefined when the user clicks the pane. */
  readonly onSelect?: (nodeId: string | undefined) => void
  /** Undo stack for the edits this tab applies. */
  readonly history?: EditHistory
  /** Generation segments of each storyboard, computed by the Host. */
  readonly segments?: Readonly<Record<string, readonly import('@deepseek-ai/dsh-canvas/client').StoryboardSegment[]>>
}

/** One icon-only toolbar action with its tooltip and accessible name. */
function Tool({ label, disabled = false, onClick, children }: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): ReactNode {
  return <Tooltip label={label} side="top" portal>
    <span className={css.toolAnchor}>
      <Button size="sm" className={css.tool} aria-label={label} disabled={disabled} onClick={onClick}>{children}</Button>
    </span>
  </Tooltip>
}

/** Viewport, selection, and refresh actions; brings newly created nodes into view. */
function Toolbar({ document, nodes, edges, edit, reload, t, undo, redo, canUndo, canRedo }: Pick<CanvasFlowProps, 'document' | 'edit' | 'reload' | 't'> & {
  nodes: readonly CanvasFlowNode[]
  edges: readonly CanvasFlowEdge[]
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}): ReactNode {
  const flow = useReactFlow()
  const selectedNodes = nodes.filter(node => node.selected === true).map(node => node.id)
  /* v8 ignore next -- jsdom measures no node dimensions, so ReactFlow never mounts edge elements;
     selected-edge deletion is covered by the recorded run */
  const selectedEdges = edges.filter(edge => edge.selected === true).map(edge => edge.id)
  const removal = deleteOperations(document, selectedNodes, selectedEdges)
  const created = document.nextId
  useEffect(() => { void flow.fitView({ duration: 200, padding: 0.15 }) }, [created, flow])
  useEffect(() => {
    const onFit = (): void => { void flow.fitView({ duration: 200, padding: 0.15 }) }
    window.addEventListener('canvas:fit', onFit)
    return () => { window.removeEventListener('canvas:fit', onFit) }
  }, [flow])
  return <div className={css.toolbar} role="toolbar" aria-label={t('toolbar')}>
    <Tool label={t('zoomOut')} onClick={() => { void flow.zoomOut() }}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 8h12" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </Tool>
    <Tool label={t('zoomIn')} onClick={() => { void flow.zoomIn() }}><IconPlusOutlineRegular /></Tool>
    <Tool label={t('fit')} onClick={() => { void flow.fitView({ duration: 200, padding: 0.15 }) }}>
      <IconFullscreenOutlineRegular />
    </Tool>
    <span className={css.toolSeparator} aria-hidden="true" />
    <Tool label={t('undo')} disabled={!canUndo} onClick={undo}>
      <IconRefreshOutlineRegular />
    </Tool>
    <Tool label={t('redo')} disabled={!canRedo} onClick={redo}>
      <IconRefreshOutlineRegular />
    </Tool>
    <span className={css.toolSeparator} aria-hidden="true" />
    <Tool label={t('remove')} disabled={removal.length === 0} onClick={() => { void edit(removal) }}>
      <IconTrashOutlineRegular />
    </Tool>
    <span className={css.toolSeparator} aria-hidden="true" />
    <Tool label={t('refresh')} onClick={() => { void reload() }}><IconRefreshOutlineRegular /></Tool>
  </div>
}

/**
 * Draw one canvas document and turn the user's gestures into edits; the Host's next document replaces local positions.
 * @param props - document, media reads, copy, and the edit and reload calls.
 * @returns the flow with its toolbar and overview.
 */
export function CanvasFlow({ document, readFile, t, edit, reload, onSelect, history, segments = {} }: CanvasFlowProps): ReactNode {
  const [drawn, setDrawn] = useState({ document, readFile, t, edit })
  const apply = useCallback(async (operations: readonly CanvasOperation[]) => {
    history?.record(document, operations, t('undo.edit'))
    await edit(operations)
  }, [history, document, edit, t])
  const face = { readFile, t, edit: apply }
  const [nodes, setNodes] = useState(() => flowNodes(document, face, segments))
  const [edges, setEdges] = useState(() => flowEdges(document, t))
  if (drawn.document !== document || drawn.readFile !== readFile || drawn.t !== t || drawn.edit !== edit) {
    setDrawn({ document, readFile, t, edit })
    setNodes(keepSelection(flowNodes(document, face, segments), nodes))
    setEdges(keepSelection(flowEdges(document, t), edges))
  }
  const gestures = useGestures<CanvasFlowNode, CanvasFlowEdge>({
    document, apply, edit, nodes, setNodes, setEdges,
    ...history === undefined ? {} : { history },
    confirmDelete: count => t('canvas.confirmDelete', { count }), groupTitle: t('group.new'),
  })
  return <ReactFlow
    className={css.flow} nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} fitView minZoom={0.1} maxZoom={2}
    deleteKeyCode={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}
    onNodesChange={gestures.onNodesChange} onEdgesChange={gestures.onEdgesChange}
    onNodeDragStop={gestures.onNodeDragStop} onConnect={gestures.onConnect}
    onConnectStart={gestures.onConnectStart} onConnectEnd={gestures.onConnectEnd} onBeforeDelete={gestures.onBeforeDelete}
    onNodeClick={(_event, node) => { onSelect?.(node.id) }}
    onPaneClick={() => { onSelect?.(undefined) }}>
    <Background gap={24} />
    <MiniMap className={css.minimap} ariaLabel={t('minimap')} pannable zoomable />
    <Toolbar document={document} nodes={nodes} edges={edges} edit={apply} reload={reload} t={t}
      undo={gestures.undo} redo={gestures.redo}
      canUndo={history?.canUndo() ?? false} canRedo={history?.canRedo() ?? false} />
    <CanvasRoleMenu document={document} menu={gestures.menu} t={t}
      onPick={gestures.pickRole} onClose={gestures.dismissMenu} />
  </ReactFlow>
}
