/** What an external canvas change did, as the tab reports it. */
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'

/**
 * Nodes a newer document added.
 * @param previous - document shown before the change, when one was read.
 * @param next - document just read.
 * @returns ids of nodes that were not in the previous document.
 */
export function newNodeIds(previous: CanvasDocument | undefined, next: CanvasDocument): string[] {
  if (previous === undefined) return []
  const known = new Set(previous.nodes.map(node => node.id))
  return next.nodes.filter(node => !known.has(node.id)).map(node => node.id)
}

/**
 * Whether a newer document should flash the nodes it added.
 * @param previousRevision - revision shown before the read.
 * @param nextRevision - revision just read.
 * @returns true when the document moved forward, not on the first read or a reload of the same revision.
 */
export function movedForward(previousRevision: number | undefined, nextRevision: number): boolean {
  return previousRevision !== undefined && nextRevision > previousRevision
}
