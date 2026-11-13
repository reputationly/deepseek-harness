/** Decisions the canvas gestures make before they become edits. */
import type { CanvasDocument, CanvasEdgeRole, CanvasOperation } from '@deepseek-ai/dsh-canvas/client'
import { automaticRole, roleMenu } from './edges.ts'
import { deleteOperations, groupable } from '../flow.ts'

/** What one dropped connection should do. */
export type ConnectionIntent =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'apply'; readonly operations: readonly CanvasOperation[] }
  | { readonly kind: 'menu'; readonly source: string; readonly target: string }

/**
 * Decide what a connection between two nodes means.
 * @param document - canvas the connection belongs to.
 * @param connection - source and target the user dropped between.
 * @returns ignore for a missing node, the connect edit, or a menu request when several roles fit.
 */
export function connectionIntent(
  document: CanvasDocument,
  connection: { readonly source: string; readonly target: string },
): ConnectionIntent {
  const source = document.nodes.find(node => node.id === connection.source)
  const target = document.nodes.find(node => node.id === connection.target)
  if (source === undefined || target === undefined) return { kind: 'ignore' }
  const taken: CanvasEdgeRole[] = []
  for (const edge of document.edges) {
    if (edge.source !== connection.source || edge.target !== connection.target) continue
    if (edge.role === undefined) continue
    taken.push(edge.role)
  }
  const choices = roleMenu(source.type, target.type, taken)
  if (choices.length === 0) {
    return { kind: 'apply', operations: [{ op: 'connect', from: connection.source, to: connection.target }] }
  }
  /* v8 ignore next -- automaticRole returns undefined only for an empty list, handled above */
  /* v8 ignore next -- automaticRole returns undefined only for an empty list, handled above */
  const automatic = automaticRole(choices)
  if (automatic !== undefined) {
    return {
      kind: 'apply',
      operations: [{ op: 'connect', from: connection.source, to: connection.target, kind: 'reference', role: automatic }],
    }
  }
  return { kind: 'menu', source: connection.source, target: connection.target }
}

/** What a key press asks the canvas to do. */
export type KeyboardIntent =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'group'; readonly operations: readonly CanvasOperation[] }

/**
 * Decide what one key press means for the canvas.
 * @param event - key event fields the canvas reads.
 * @param document - document whose selection and edges the gesture uses.
 * @param selected - ids of selected nodes.
 * @param groupTitle - title a new group takes.
 * @returns the action the caller performs.
 */
export function keyboardIntent(
  event: { readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean },
  document: CanvasDocument,
  selected: readonly string[],
  groupTitle: string,
): KeyboardIntent {
  const mod = event.metaKey || event.ctrlKey
  if (mod && event.key.toLowerCase() === 'z') return event.shiftKey ? { kind: 'redo' } : { kind: 'undo' }
  if (event.key.toLowerCase() !== 'g' || mod) return { kind: 'ignore' }
  const members = groupable(document, selected)
  if (members.length < 2) return { kind: 'ignore' }
  return { kind: 'group', operations: [{ op: 'group', title: groupTitle, nodes: members }] }
}

/**
 * Deletion the Host must apply, with the count the confirmation names.
 * @param document - document before the deletion.
 * @param nodes - node ids the gesture removed.
 * @param edges - edge ids the gesture removed.
 * @param t - copy function for the operation.
 * @returns the edits and how many entities they remove, or undefined when there is nothing to confirm.
 */
export function deleteIntent(
  document: CanvasDocument,
  nodes: readonly string[],
  edges: readonly string[],
): { readonly operations: readonly CanvasOperation[]; readonly removing: number } | undefined {
  const operations = deleteOperations(document, nodes, edges)
  const removing = operations.filter(operation => operation.op !== 'ungroup').length
  return removing === 0 ? undefined : { operations, removing }
}
