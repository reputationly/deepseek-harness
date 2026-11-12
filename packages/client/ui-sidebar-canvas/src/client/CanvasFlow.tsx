/** The canvas drawn as a flow: pan, zoom, drag, connect, group, and delete. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  applyEdgeChanges, applyNodeChanges, Background, MiniMap, ReactFlow, useReactFlow,
  type EdgeChange, type NodeChange, type OnBeforeDelete, type OnConnect, type OnConnectEnd, type OnConnectStart,
  type OnNodeDrag,
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
import { NODE_TYPES } from './nodes/index.ts'
import { RoleMenu } from './RoleMenu.tsx'
import { automaticRole, roleMenu } from './model/edges.ts'
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
    <Tool label={t('group')} disabled={members.length < 2} onClick={() => { void edit([{ op: 'group', title: t('group.new'), nodes: members }]) }}>
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
export function CanvasFlow({ document, readFile, t, edit, reload, onSelect, history }: CanvasFlowProps): ReactNode {
  const [menu, setMenu] = useState<{ x: number; y: number; source: string; target: string }>()
  const pointer = useRef({ x: 0, y: 0 })
  const apply = useCallback(async (operations: readonly CanvasOperation[]) => {
    history?.record(document, operations, t('undo.edit'))
    await edit(operations)
  }, [history, document, edit, t])
  const undo = useCallback(() => {
    const operations = history?.undo()
    if (operations !== undefined) void edit(operations)
  }, [history, edit])
  const redo = useCallback(() => {
    const operations = history?.redo()
    if (operations !== undefined) void edit(operations)
  }, [history, edit])
  const face = { readFile, t, edit: apply }
  const [drawn, setDrawn] = useState({ document, readFile, t, edit })
  const [nodes, setNodes] = useState(() => flowNodes(document, face))
  const [edges, setEdges] = useState(() => flowEdges(document, t))
  if (drawn.document !== document || drawn.readFile !== readFile || drawn.t !== t || drawn.edit !== edit) {
    setDrawn({ document, readFile, t, edit })
    setNodes(keepSelection(flowNodes(document, face), nodes))
    setEdges(keepSelection(flowEdges(document, t), edges))
  }
  const onNodesChange = useCallback((changes: NodeChange<CanvasFlowNode>[]) => {
    setNodes(current => applyNodeChanges(changes, current))
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange<CanvasFlowEdge>[]) => {
    setEdges(current => applyEdgeChanges(changes, current))
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (event.key.toLowerCase() !== 'g' || event.metaKey || event.ctrlKey) return
      const members = groupable(document, nodes.filter(node => node.selected === true).map(node => node.id))
      if (members.length < 2) return
      event.preventDefault()
      void apply([{ op: 'group', title: t('group.new'), nodes: members }])
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [apply, document, nodes, redo, t, undo])

  const onNodeDragStop = useCallback<OnNodeDrag<CanvasFlowNode>>((_event, _node, dragged) => {
    void apply(moveOperations(document, dragged))
  }, [document, apply])
  const onConnectStart = useCallback<OnConnectStart>((event) => {
    pointer.current = { x: (event as MouseEvent).clientX ?? 0, y: (event as MouseEvent).clientY ?? 0 }
  }, [])
  const onConnectEnd = useCallback<OnConnectEnd>((event) => {
    const point = event as MouseEvent
    if (typeof point.clientX === 'number') pointer.current = { x: point.clientX, y: point.clientY }
  }, [])
  const onConnect = useCallback<OnConnect>((connection) => {
    const source = document.nodes.find(node => node.id === connection.source)
    const target = document.nodes.find(node => node.id === connection.target)
    if (source === undefined || target === undefined) return
    const taken = document.edges
      .filter(edge => edge.source === connection.source && edge.target === connection.target)
      .flatMap(edge => edge.role === undefined ? [] : [edge.role])
    const choices = roleMenu(source.type, target.type, taken)
    if (choices.length === 0) {
      void apply([{ op: 'connect', from: connection.source, to: connection.target }])
      return
    }
    const automatic = automaticRole(choices)
    if (automatic !== undefined) {
      void apply([{ op: 'connect', from: connection.source, to: connection.target, kind: 'reference', role: automatic }])
      return
    }
    setMenu({ x: pointer.current.x, y: pointer.current.y, source: connection.source, target: connection.target })
  }, [apply, document])
  // The Host owns deletion: the gesture becomes edits and the flow keeps its items until the next document.
  const onBeforeDelete = useCallback<OnBeforeDelete<CanvasFlowNode, CanvasFlowEdge>>(async (deleted) => {
    await apply(deleteOperations(document, deleted.nodes.map(node => node.id), deleted.edges.map(edge => edge.id)))
    return false
  }, [document, apply])
  return <ReactFlow
    className={css.flow} nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} fitView minZoom={0.1} maxZoom={2}
    deleteKeyCode={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}
    onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeDragStop={onNodeDragStop}
    onConnect={onConnect} onConnectStart={onConnectStart} onConnectEnd={onConnectEnd} onBeforeDelete={onBeforeDelete}
    onNodeClick={(_event, node) => { onSelect?.(node.id) }}
    onPaneClick={() => { onSelect?.(undefined) }}>
    <Background gap={24} />
    <MiniMap className={css.minimap} ariaLabel={t('minimap')} pannable zoomable />
    <Toolbar document={document} nodes={nodes} edges={edges} edit={apply} reload={reload} t={t}
      undo={undo} redo={redo} canUndo={history?.canUndo() ?? false} canRedo={history?.canRedo() ?? false} />
    {menu === undefined ? undefined : <RoleMenu
      x={menu.x} y={menu.y} choices={roleMenu(
        document.nodes.find(node => node.id === menu.source)?.type ?? 'text',
        document.nodes.find(node => node.id === menu.target)?.type ?? 'text',
        document.edges.filter(edge => edge.source === menu.source && edge.target === menu.target)
          .flatMap(edge => edge.role === undefined ? [] : [edge.role]),
      )}
      onPick={(role) => {
        const pending = menu
        setMenu(undefined)
        void apply([{ op: 'connect', from: pending.source, to: pending.target, kind: 'reference', role }])
      }}
      onClose={() => { setMenu(undefined) }} t={t}
    />}
  </ReactFlow>
}
