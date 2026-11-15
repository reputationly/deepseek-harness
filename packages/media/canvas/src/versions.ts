/** Version selection shared by Host resolution and read-only client previews. */
import type { CanvasNode, NodeVersion } from './types.ts'

/**
 * Resolve the explicitly adopted version; candidates never become implicit inputs.
 * @param node - node whose adoption is being resolved.
 * @returns the adopted version, or undefined when none is adopted.
 */
export function activeVersionOf(node: CanvasNode): NodeVersion | undefined {
  return node.versions?.find(version => version.id === node.activeVersion)
}

/**
 * Choose a read-only preview without adopting a candidate.
 * @param node - node being previewed.
 * @returns its adopted version, latest candidate, or undefined when no version exists.
 */
export function previewVersionOf(node: CanvasNode): NodeVersion | undefined {
  return activeVersionOf(node) ?? node.versions?.at(-1)
}
