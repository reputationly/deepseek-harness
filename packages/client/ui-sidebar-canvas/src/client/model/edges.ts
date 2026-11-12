/** How an edge reads: which roles a connection may carry, and the label and style each role draws. */
import type { CanvasEdgeRole, CanvasNodeType } from '@deepseek-ai/dsh-canvas/client'

/** One choice the connection menu offers. */
export interface RoleChoice {
  readonly role: CanvasEdgeRole
  /** Copy key the menu renders. */
  readonly labelKey: 'edge.ref' | 'edge.firstFrame' | 'edge.lastFrame' | 'edge.prompt' | 'edge.audio' | 'edge.source'
  /** Whether the two nodes already have this role, which makes the choice unavailable. */
  readonly taken: boolean
}

/** Roles one pair of node kinds may carry. */
const ROLES: Partial<Record<CanvasNodeType, Partial<Record<CanvasNodeType, readonly CanvasEdgeRole[]>>>> = {
  image: { image: ['ref'], video: ['ref', 'first_frame', 'last_frame'], timeline: ['source'] },
  audio: { video: ['audio'], timeline: ['source'] },
  video: { timeline: ['source'] },
  text: {
    image: ['prompt'], video: ['prompt'], audio: ['prompt'], storyboard: ['prompt'], script: ['prompt'],
  },
  script: {
    image: ['prompt'], video: ['prompt'], audio: ['prompt'], storyboard: ['prompt'], script: ['prompt'],
  },
  storyboard: {
    image: ['prompt'], video: ['prompt'], audio: ['prompt'], storyboard: ['prompt'], script: ['prompt'],
  },
}

const LABEL_KEYS: Record<CanvasEdgeRole, RoleChoice['labelKey']> = {
  ref: 'edge.ref',
  first_frame: 'edge.firstFrame',
  last_frame: 'edge.lastFrame',
  prompt: 'edge.prompt',
  audio: 'edge.audio',
  source: 'edge.source',
}

/**
 * Roles a connection may carry, in menu order, with the ones already present marked.
 * @param source - kind of the node the edge starts at.
 * @param target - kind of the node the edge points to.
 * @param taken - roles the pair already has.
 * @returns the choices, or an empty list when the pair carries no input.
 */
export function roleMenu(source: CanvasNodeType, target: CanvasNodeType, taken: readonly CanvasEdgeRole[]): RoleChoice[] {
  const roles = ROLES[source]?.[target] ?? []
  const present = new Set(taken)
  return roles.map(role => ({ role, labelKey: LABEL_KEYS[role], taken: present.has(role) }))
}

/**
 * Role an edge takes when the connection menu offers exactly one usable choice.
 * @param choices - menu entries for the pair.
 * @returns the only role left, or undefined when the user must choose.
 */
export function automaticRole(choices: readonly RoleChoice[]): CanvasEdgeRole | undefined {
  const open = choices.filter(choice => !choice.taken)
  return open.length === 1 ? open[0]?.role : undefined
}

/** Style one edge draws: derivation solid, prompt dashed grey, frames and references colored by role. */
export interface EdgeStyle {
  /** Dash pattern; absent for a solid line. */
  readonly strokeDasharray?: string
  /** CSS color token or value. */
  readonly stroke: string
}

const STYLES: Record<CanvasEdgeRole, EdgeStyle> = {
  prompt: { strokeDasharray: '6 4', stroke: 'var(--dsh-color-border-strong)' },
  ref: { stroke: 'var(--dsh-color-accent)' },
  first_frame: { stroke: 'var(--dsh-color-success)' },
  last_frame: { stroke: 'var(--dsh-color-warning)' },
  audio: { stroke: 'var(--dsh-color-info)' },
  source: { stroke: 'var(--dsh-color-text-tertiary)' },
}

/**
 * Style for one edge.
 * @param role - the edge's reference role, absent on a derivation edge.
 * @returns dash and color.
 */
export function edgeStyle(role: CanvasEdgeRole | undefined): EdgeStyle {
  return role === undefined ? { stroke: 'var(--dsh-color-border)' } : STYLES[role]
}

/**
 * Copy key and parameters for an edge label.
 * @param role - the edge's reference role, absent on a derivation edge.
 * @param order - reference order, which the label shows one-based.
 * @returns the label key and its parameters; a derivation edge has none.
 */
export function edgeLabel(role: CanvasEdgeRole | undefined, order: number | undefined): { readonly key: RoleChoice['labelKey']; readonly n: number } | undefined {
  if (role === undefined) return undefined
  return { key: LABEL_KEYS[role], n: (order ?? 0) + 1 }
}
