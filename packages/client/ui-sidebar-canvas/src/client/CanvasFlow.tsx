/** The canvas drawn as a flow: pan, zoom, drag, connect, group, and delete. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  applyEdgeChanges, applyNodeChanges, Background, MiniMap, ReactFlow, useReactFlow,
  type EdgeChange, type NodeChange, type OnBeforeDelete, type OnConnect, type OnNodeDrag,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Button, IconFullscreenOutlineRegular, IconLayersOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
  IconTrashOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasDocument, CanvasOperation } from '@deepseek-ai/dsh-canvas/client'
import {
  deleteOperations, flowEdges, flowNodes, groupable, keepSelection, moveOperations,
  type CanvasFlowEdge, type CanvasFlowNode, type CanvasNodeFace,
} from './flow.ts'
import { NODE_TYPES } from './nodes.tsx'
import css from './CanvasFlow.module.css'

/** The document to draw and the calls its edits go through. */
export type CanvasFlowProps = CanvasNodeFace & {
  readonly document: CanvasDocument
  readonly edit: (operations: readonly CanvasOperation[]) => Promise<void>
  readonly reload: () => Promise<void>
}

/** One icon-only toolbar action with its tooltip and accessible name. */
function Tool({ label, disabled = false, onClick, children }: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): ReactNode {
  return <Tooltip label={label} side="top">
    <span className={css.toolAnchor}>
      <Button size="sm" className={css.tool} aria-label={label} disabled={disabled} onClick={onClick}>{children}</Button>
    </span>
  </Tooltip>
}

/** Viewport, selection, and refresh actions; brings newly created nodes into view. */
function Toolbar({ document, nodes, edges, edit, reload, t }: Pick<CanvasFlowProps, 'document' | 'edit' | 'reload' | 't'> & {
  nodes: readonly CanvasFlowNode[]
  edges: readonly CanvasFlowEdge[]
}): ReactNode {
  const flow = useReactFlow()
  const selectedNodes = nodes.filter(node => node.selected === true).map(node => node.id)
  const selectedEdges = edges.filter(edge => edge.selected === true).map(edge => edge.id)
  const members = groupable(document, selectedNodes)
  const removal = deleteOperations(document, selectedNodes, selectedEdges)
  const created = document.nextId
  useEffect(() => { void flow.fitView({ duration: 200, padding: 0.15 }) }, [created, flow])
  return <div className={css.toolbar} role="toolbar" aria-label={t('toolbar')}>
    <Tool label={t('zoomOut')} onClick={() => { void flow.zoomOut() }}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 8h12" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </Tool>
    <Tool label={t('zoomIn')} onClick={() => { void flow.zoomIn() }}><IconPlusOutlineRegular /></Tool>
    <Tool label={t('fit')} onClick={() => { void flow.fitView({ duration: 200, padding: 0.15 }) }}><IconFullscreenOutlineRegular /></Tool>
    <span className={css.toolSeparator} aria-hidden="true" />
    <Tool label={t('group')} disabled={members.length === 0} onClick={() => { void edit([{ op: 'group', title: t('group.new'), nodes: members }]) }}>
      <IconLayersOutlineRegular />
    </Tool>
    <Tool label={t('remove')} disabled={removal.length === 0} onClick={() => { void edit(removal) }}><IconTrashOutlineRegular /></Tool>
    <span className={css.toolSeparator} aria-hidden="true" />
    <Tool label={t('refresh')} onClick={() => { void reload() }}><IconRefreshOutlineRegular /></Tool>
  </div>
}

/**
 * Draw one canvas document and turn the user's gestures into edits; the Host's next document replaces local positions.
 * @param props - document, media reads, copy, and the edit and reload calls.
 * @returns the flow with its toolbar and overview.
 */
export function CanvasFlow({ document, readFile, t, edit, reload }: CanvasFlowProps): ReactNode {
  const [drawn, setDrawn] = useState({ document, readFile, t })
  const [nodes, setNodes] = useState(() => flowNodes(document, { readFile, t }))
  const [edges, setEdges] = useState(() => flowEdges(document))
  if (drawn.document !== document || drawn.readFile !== readFile || drawn.t !== t) {
    setDrawn({ document, readFile, t })
    setNodes(keepSelection(flowNodes(document, { readFile, t }), nodes))
    setEdges(keepSelection(flowEdges(document), edges))
  }
  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    setNodes(current => applyNodeChanges(changes, current))
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange<CanvasFlowEdge>[]) => {
    setEdges(current => applyEdgeChanges(changes, current))
  }, [])
  const onNodeDragStop = useCallback<OnNodeDrag<CanvasFlowNode>>((_event, _node, dragged) => {
    void edit(moveOperations(document, dragged))
  }, [document, edit])
  const onConnect = useCallback<OnConnect>((connection) => {
    void edit([{ op: 'connect', from: connection.source, to: connection.target }])
  }, [edit])
  // The Host owns deletion: the gesture becomes edits and the flow keeps its items until the next document.
  const onBeforeDelete = useCallback<OnBeforeDelete<CanvasFlowNode, CanvasFlowEdge>>(async (deleted) => {
    await edit(deleteOperations(document, deleted.nodes.map(node => node.id), deleted.edges.map(edge => edge.id)))
    return false
  }, [document, edit])
  return <ReactFlow
    className={css.flow} nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} fitView minZoom={0.1} maxZoom={2}
    deleteKeyCode={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}
    onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeDragStop={onNodeDragStop}
    onConnect={onConnect} onBeforeDelete={onBeforeDelete}>
    <Background gap={24} />
    <MiniMap className={css.minimap} ariaLabel={t('minimap')} pannable zoomable />
    <Toolbar document={document} nodes={nodes} edges={edges} edit={edit} reload={reload} t={t} />
  </ReactFlow>
}
