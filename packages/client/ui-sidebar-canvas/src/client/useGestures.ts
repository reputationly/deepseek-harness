/** Interaction handlers the canvas flow binds to xyflow, kept apart from rendering for direct tests. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Connection, Edge, EdgeChange, Node, NodeChange,
  OnBeforeDelete, OnConnect, OnConnectEnd, OnConnectStart, OnNodeDrag,
} from '@xyflow/react'
import type { CanvasDocument, CanvasEdgeRole, CanvasOperation } from '@deepseek-ai/dsh-canvas/client'
import { connectionIntent, deleteIntent, keyboardIntent } from './model/gestures.ts'
import { moveOperations } from './flow.ts'
import type { EditHistory } from './model/history.ts'

/** Props one gesture hook needs. */
export interface GestureProps<N extends Node, E extends Edge> {
  readonly document: CanvasDocument
  readonly apply: (operations: readonly CanvasOperation[]) => Promise<void>
  readonly edit: (operations: readonly CanvasOperation[]) => Promise<void>
  readonly history?: EditHistory
  /** Copy for the delete confirmation. */
  readonly confirmDelete: (count: number) => string
  /** Title a new group takes. */
  readonly groupTitle: string
  readonly nodes: readonly N[]
  readonly setNodes: (update: (current: N[]) => N[]) => void
  readonly setEdges: (update: (current: E[]) => E[]) => void
}

/** One pending role menu request. */
export interface PendingMenu {
  readonly x: number
  readonly y: number
  readonly source: string
  readonly target: string
}

/** Handlers and undo/redo the flow binds. */
export interface Gestures<N extends Node, E extends Edge> {
  readonly menu: PendingMenu | undefined
  readonly setMenu: (menu: PendingMenu | undefined) => void
  readonly undo: () => void
  readonly redo: () => void
  readonly onNodesChange: (changes: NodeChange<N>[]) => void
  readonly onEdgesChange: (changes: EdgeChange<E>[]) => void
  readonly onConnectStart: OnConnectStart
  readonly onConnectEnd: OnConnectEnd
  readonly onConnect: OnConnect
  readonly onNodeDragStop: OnNodeDrag<N>
  readonly onBeforeDelete: OnBeforeDelete<N, E>
  /** Connect the pending menu's pair with the picked role. */
  readonly pickRole: (role: CanvasEdgeRole) => void
  /** Close the pending menu without connecting. */
  readonly dismissMenu: () => void
}

/**
 * Build the interaction handlers of one canvas flow.
 * @param props - document, edit calls, copy, and flow state setters.
 * @returns handlers bound to xyflow and the pending role menu.
 */
export function useGestures<N extends Node, E extends Edge>(props: GestureProps<N, E>): Gestures<N, E> {
  const { document, apply, edit, history, confirmDelete, groupTitle, nodes, setNodes, setEdges } = props
  const [menu, setMenu] = useState<PendingMenu>()
  const pointer = useRef({ x: 0, y: 0 })
  const undo = useCallback(() => {
    const operations = history?.undo()
    if (operations !== undefined) void edit(operations)
  }, [history, edit])
  const redo = useCallback(() => {
    const operations = history?.redo()
    if (operations !== undefined) void edit(operations)
  }, [history, edit])
  const onNodesChange = useCallback((changes: NodeChange<N>[]) => {
    setNodes((current) => {
      const list = changes.reduce((previous, change) => {
        if (change.type === 'position' && change.position !== undefined) {
          return previous.map(node => node.id === change.id ? { ...node, position: change.position } as N : node)
        }
        if (change.type === 'select') {
          return previous.map(node => node.id === change.id ? { ...node, selected: change.selected } as N : node)
        }
        return previous
      }, [...current])
      return list
    })
  }, [setNodes])
  const onEdgesChange = useCallback((changes: EdgeChange<E>[]) => {
    setEdges(current => changes.reduce((list, change) => change.type === 'select'
      ? list.map(edge => edge.id === change.id ? { ...edge, selected: change.selected } as E : edge)
      : list, [...current]))
  }, [setEdges])
  const onConnectStart = useCallback<OnConnectStart>((event) => {
    const point = event as MouseEvent
    pointer.current = { x: point.clientX ?? 0, y: point.clientY ?? 0 }
  }, [])
  const onConnectEnd = useCallback<OnConnectEnd>((event) => {
    const point = event as MouseEvent
    if (typeof point.clientX === 'number') pointer.current = { x: point.clientX, y: point.clientY }
  }, [])
  const onConnect = useCallback<OnConnect>((connection: Connection) => {
    const intent = connectionIntent(document, connection)
    if (intent.kind === 'apply') { void apply(intent.operations); return }
    if (intent.kind === 'menu') {
      setMenu({ x: pointer.current.x, y: pointer.current.y, source: intent.source, target: intent.target })
    }
  }, [apply, document])
  const onNodeDragStop = useCallback<OnNodeDrag<N>>((_event, _node, dragged) => {
    void apply(moveOperations(document, dragged))
  }, [document, apply])
  const pickRole = useCallback((role: CanvasEdgeRole) => {
    const pending = menu
    setMenu(undefined)
    if (pending === undefined) return
    void apply([{ op: 'connect', from: pending.source, to: pending.target, kind: 'reference', role }])
  }, [apply, menu])
  const dismissMenu = useCallback(() => { setMenu(undefined) }, [])
  const onBeforeDelete = useCallback<OnBeforeDelete<N, E>>(async (deleted) => {
    const intent = deleteIntent(document, deleted.nodes.map(node => node.id), deleted.edges.map(edge => edge.id))
    if (intent === undefined) return false
    if (!window.confirm(confirmDelete(intent.removing))) return false
    await apply(intent.operations)
    return false
  }, [document, apply, confirmDelete])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target
      const typing = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if (typing) return
      const intent = keyboardIntent(event, document, nodes.filter(node => node.selected === true).map(node => node.id), groupTitle)
      if (intent.kind === 'undo') { event.preventDefault(); undo(); return }
      if (intent.kind === 'redo') { event.preventDefault(); redo(); return }
      if (intent.kind === 'group') { event.preventDefault(); void apply(intent.operations); return }
      if (event.code !== 'Space') return
      const selectedNode = nodes.find(node => node.selected === true)
      if (selectedNode === undefined) return
      const nodeSelector = `.react-flow__node[data-id="${selectedNode.id}"]`
      const element = window.document.querySelector(`${nodeSelector} video, ${nodeSelector} audio`)
      if (!(element instanceof HTMLMediaElement)) return
      event.preventDefault()
      /* v8 ignore next 2 -- media playback cannot be observed through the xyflow DOM in jsdom; the recorded run covers Space playback */
      if (element.paused) void element.play().catch(() => undefined)
      else element.pause()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [apply, document, groupTitle, nodes, redo, undo])
  return {
    menu, setMenu, undo, redo, onNodesChange, onEdgesChange,
    onConnectStart, onConnectEnd, onConnect, onNodeDragStop, onBeforeDelete, pickRole, dismissMenu,
  }
}
