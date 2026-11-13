/** Pure mapping between the canvas document and the flow the tab draws and edits. */
import { MarkerType, type Edge, type Node } from '@xyflow/react'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasDocument, CanvasNode, CanvasNodeId, CanvasOperation, StoryboardSegment } from '@deepseek-ai/dsh-canvas/client'
import { shotBadge } from './model/cards.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { edgeLabel, edgeStyle } from './model/edges.ts'
import type { ReadCanvasFile } from './face.ts'
import type { NS } from './locales.ts'

/** What every node card reads besides its document node. */
export type CanvasNodeFace = {
  readonly readFile: ReadCanvasFile
  readonly t: PropsLocale<typeof NS>['t']
  /** Applies the user's edits, such as switching the shown version. */
  readonly edit: (operations: readonly CanvasOperation[]) => Promise<void>
}

/** One drawn node: the document node, its group size, and the face its card reads. */
export type CanvasFlowNode = Node<{
  node: CanvasNode
  members?: number
  segments?: readonly StoryboardSegment[]
  segmentBadge?: string
} & CanvasNodeFace>

/** One drawn edge. */
export type CanvasFlowEdge = Edge

/**
 * Draw the document's nodes; group members are positioned inside their group.
 * @param document - canvas document.
 * @param face - media reads and copy handed to every card.
 * @returns groups first, then content nodes, as the flow requires parents before children.
 */
/** Segment badge of a video node, using the storyboard the view computed and the node's scene group. */
function segmentBadgeOf(
  document: CanvasDocument,
  node: CanvasNode,
  segments: Readonly<Record<string, readonly StoryboardSegment[]>>,
): string | undefined {
  const shot = node.gen?.shot
  if (shot === undefined) return undefined
  const board = document.nodes.find(candidate => candidate.id === shot.storyboard)
  const group = document.nodes.find(candidate => candidate.id === node.group)
  return shotBadge(node, board, group?.sceneOrigin?.scene, board === undefined ? [] : segments[board.id] ?? [])
}

export function flowNodes(
  document: CanvasDocument,
  face: CanvasNodeFace,
  segments: Readonly<Record<string, readonly StoryboardSegment[]>> = {},
): CanvasFlowNode[] {
  const groups = new Map(document.nodes.filter(node => node.type === 'group').map(node => [node.id, node]))
  return [...groups.values(), ...document.nodes.filter(node => node.type !== 'group')].map((node) => {
    const parent = node.group === undefined ? undefined : groups.get(node.group)
    const badge = segmentBadgeOf(document, node, segments)
    return {
      id: node.id,
      // `group` is a built-in flow type with its own styling; the frame card draws groups instead.
      type: node.type === 'group' ? 'frame' : node.type,
      position: parent === undefined ? { x: node.x, y: node.y } : { x: node.x - parent.x, y: node.y - parent.y },
      width: node.width,
      height: node.height,
      data: {
        node,
        ...node.type === 'group' ? { members: document.nodes.filter(child => child.group === node.id).length } : {},
        ...node.type === 'storyboard' && segments[node.id] !== undefined ? { segments: segments[node.id] } : {},
        ...badge === undefined ? {} : { segmentBadge: badge },
        ...face,
      },
      ...parent === undefined ? {} : { parentId: parent.id },
    }
  })
}

/**
 * Draw the document's edges with the role's style and label.
 * @param document - canvas document.
 * @param t - copy bound to this plugin's keys.
 * @returns one arrow per edge.
 */
export function flowEdges(document: CanvasDocument, t: CanvasNodeFace['t']): CanvasFlowEdge[] {
  return document.edges.map((edge) => {
    const style = edgeStyle(edge.role)
    const label = edgeLabel(edge.role, edge.order)
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke: style.stroke,
        ...style.strokeDasharray === undefined ? {} : { strokeDasharray: style.strokeDasharray },
      },
      ...label === undefined ? {} : { label: t(label.key, { n: label.n }) },
    }
  })
}

/**
 * Carry the user's selection onto a redrawn flow.
 * @param next - redrawn nodes or edges.
 * @param previous - what was drawn before.
 * @returns `next` with every still-present selected item selected.
 */
export function keepSelection<Item extends { id: string; selected?: boolean }>(next: Item[], previous: readonly Item[]): Item[] {
  const selected = new Set(previous.filter(item => item.selected === true).map(item => item.id))
  return next.map(item => selected.has(item.id) ? { ...item, selected: true } : item)
}

/**
 * Edits that record where the user dropped nodes.
 * @param document - canvas document the drag started from.
 * @param dropped - dragged nodes with their flow positions.
 * @returns one move per node that changed place; a member dragged along with its group is moved by the group.
 */
export function moveOperations(
  document: CanvasDocument, dropped: readonly Pick<CanvasFlowNode, 'id' | 'position'>[],
): CanvasOperation[] {
  const nodes = new Map(document.nodes.map(node => [node.id, node]))
  const moved = new Set<string>(dropped.map(node => node.id))
  return dropped.flatMap((drop): CanvasOperation[] => {
    const node = nodes.get(brandString<CanvasNodeId>(drop.id))
    if (node === undefined || (node.group !== undefined && moved.has(node.group))) return []
    const parent = node.group === undefined ? undefined : nodes.get(node.group)
    const x = Math.round(drop.position.x + (parent?.x ?? 0))
    const y = Math.round(drop.position.y + (parent?.y ?? 0))
    return x === node.x && y === node.y ? [] : [{ op: 'move', node: node.id, x, y }]
  })
}

/**
 * Edits that delete what the user selected.
 * @param document - canvas document.
 * @param nodeIds - selected nodes; a group is dissolved and its members stay.
 * @param edgeIds - selected edges.
 * @returns removals first, then disconnects of edges those removals leave in place.
 */
export function deleteOperations(
  document: CanvasDocument, nodeIds: readonly string[], edgeIds: readonly string[],
): CanvasOperation[] {
  const nodes = new Map(document.nodes.map(node => [node.id, node]))
  const selected = nodeIds.flatMap((id) => {
    const node = nodes.get(brandString<CanvasNodeId>(id))
    return node === undefined ? [] : [node]
  })
  const groups = new Set(selected.filter(node => node.type === 'group').map(node => node.id))
  // Deleting a group frame reports its members too; only the frame goes.
  const removed = selected.filter(node => node.type !== 'group' && (node.group === undefined || !groups.has(node.group)))
  const gone = new Set(removed.map(node => node.id))
  const edges = new Set(edgeIds)
  return [
    ...[...groups].map((node): CanvasOperation => ({ op: 'ungroup', node })),
    ...removed.map((node): CanvasOperation => ({ op: 'remove', node: node.id })),
    ...document.edges
      .filter(edge => edges.has(edge.id) && !gone.has(edge.source) && !gone.has(edge.target))
      .map((edge): CanvasOperation => ({ op: 'disconnect', from: edge.source, to: edge.target })),
  ]
}

/**
 * The selection a new group can hold.
 * @param document - canvas document.
 * @param nodeIds - selected nodes.
 * @returns selected content nodes that are in no group yet.
 */
export function groupable(document: CanvasDocument, nodeIds: readonly string[]): string[] {
  const selected = new Set(nodeIds)
  return document.nodes.filter(node => selected.has(node.id) && node.type !== 'group' && node.group === undefined).map(node => node.id)
}
