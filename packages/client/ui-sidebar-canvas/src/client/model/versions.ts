/** Resolve version selections in the client wire view without importing a Host plugin runtime. */
import type { CanvasNode, NodeVersion } from '@deepseek-ai/dsh-canvas/client'

/**
 * Resolve the adopted version used by editing and generation controls.
 * @param node - node received from the Host.
 * @returns the explicit selection, or undefined for an unadopted candidate.
 */
export function activeVersionOf(node: CanvasNode): NodeVersion | undefined {
  return node.versions?.find(version => version.id === node.activeVersion)
}

/**
 * Resolve a read-only preview without changing adoption.
 * @param node - node received from the Host.
 * @returns the adopted version or latest candidate.
 */
export function previewVersionOf(node: CanvasNode): NodeVersion | undefined {
  return activeVersionOf(node) ?? node.versions?.at(-1)
}
