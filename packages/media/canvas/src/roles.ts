/**
 * Edge identity and the role an edge takes when the caller names none.
 * @module
 */

import type { CanvasEdgeRole, CanvasNodeType } from './types.ts'

/** Node kinds that read a prompt: the media a generation makes, and the tables a prompt is written into. */
const PROMPT_TARGETS: readonly CanvasNodeType[] = ['image', 'video', 'audio', 'storyboard', 'script']

/**
 * Role an edge takes from the kinds of the nodes it joins.
 * @param source - kind of the node the edge starts at.
 * @param target - kind of the node the edge points to.
 * @returns the inferred role, or undefined when the pair carries no input meaning.
 */
export function inferRole(source: CanvasNodeType, target: CanvasNodeType): CanvasEdgeRole | undefined {
  if (source === 'text' || source === 'script' || source === 'storyboard') return PROMPT_TARGETS.includes(target) ? 'prompt' : undefined
  if (source === 'image') return target === 'image' || target === 'video' ? 'ref' : target === 'timeline' ? 'source' : undefined
  if (source === 'audio') return target === 'video' ? 'audio' : target === 'timeline' ? 'source' : undefined
  if (source === 'video') return target === 'timeline' ? 'source' : undefined
  return undefined
}

/**
 * Edge id: derivation edges are keyed by their endpoints, reference edges by endpoints and role.
 * @param source - source node id.
 * @param target - target node id.
 * @param role - reference role, absent on derivation edges.
 * @returns the document-unique edge id.
 */
export function edgeId(source: string, target: string, role?: CanvasEdgeRole): string {
  return role === undefined ? `${source}->${target}` : `${source}->${target}:${role}`
}
