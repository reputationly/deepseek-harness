/** Where the inspector sits in the studio, given the room the canvas has. */
import type { CanvasDocument } from '@deepseek-ai/dsh-canvas/client'

/**
 * A video cannot use its own derived tail as an input, which would form a cycle.
 * @param document - latest nodes and connections.
 * @param target - video receiving the frame reference.
 * @returns image choices with unavailable files and descendants disabled.
 */
export function frameChoices(document: CanvasDocument, target: string): readonly {
  readonly id: string
  readonly title: string
  readonly disabled: boolean
}[] {
  const descendants = new Set([target])
  const queue = [target]
  for (const id of queue) {
    for (const edge of document.edges) {
      if (edge.source !== id || descendants.has(edge.target)) continue
      descendants.add(edge.target)
      queue.push(edge.target)
    }
  }
  return document.nodes.filter(node => node.type === 'image').map(node => ({
    id: node.id, title: node.title,
    disabled: descendants.has(node.id) || node.versions?.find(version => version.id === node.activeVersion)?.path === undefined,
  }))
}

/** Width the studio needs before the inspector may take a column of its own. */
export const INSPECTOR_MIN_WIDTH = 960

/** How the studio shows the inspector. */
export type InspectorPlacement = 'sidebar' | 'drawer'

/**
 * Placement for one studio width.
 * @param width - width of the canvas area inside the studio.
 * @param minWidth - width below which the inspector must overlay instead of take a column.
 * @returns `sidebar` when the canvas can keep its minimum with the inspector beside it.
 */
export function inspectorPlacement(width: number, minWidth = INSPECTOR_MIN_WIDTH): InspectorPlacement {
  return width >= minWidth ? 'sidebar' : 'drawer'
}

/** One parameter control the inspector renders. */
export interface ParamControl {
  readonly id: string
  readonly title: string
  readonly kind: 'select' | 'number' | 'text'
  readonly value: string
  readonly options?: readonly string[]
}

/**
 * Gateway operation one node kind generates through.
 * @param kind - Media or message kind being handled.
 * @returns Matching gateway generation operation name.
 */
export function operationFor(kind: 'image' | 'video' | 'speech' | 'music'): string {
  if (kind === 'image') return 'generate_image'
  if (kind === 'video') return 'generate_video'
  if (kind === 'music') return 'generate_music'
  return 'generate_speech'
}

/** One capability the inspector's model picker offers. */
export interface ModelChoice {
  readonly id: string
  readonly model: string
  readonly disabled: boolean
}

/**
 * Models the inspector offers for one node and the inputs it has.
 * @param capabilities - models the catalog offers for the operation.
 * @param hasFrames - whether the node has a first or last frame.
 * @param hasRefs - whether the node has reference images.
 * @returns choices in catalog order; a video model that cannot take the node's inputs is disabled.
 */
export function modelChoices(
  capabilities: readonly { readonly id: string; readonly model: string; readonly params: readonly { readonly id: string }[] }[],
  hasFrames: boolean,
  hasRefs: boolean,
): ModelChoice[] {
  return capabilities.map((capability) => {
    const acceptsRefs = capability.params.some(param => param.id === 'src_ref_images')
    return { id: capability.id, model: capability.model, disabled: hasFrames && hasRefs && !acceptsRefs }
  })
}


/** One catalog parameter as the inspector reads it. */
export interface CatalogParam {
  readonly id: string
  readonly title?: string
  readonly options?: readonly string[]
  readonly default?: string
  readonly type?: string
}

/**
 * Build parameter controls from the selected capability and saved values.
 * @param capability - Selected model and its catalog parameters.
 * @param current - Parameter values already saved on the node.
 * @returns One control per catalog parameter, retaining any saved value.
 */
export function paramControls(
  capability: { readonly params: readonly CatalogParam[] } | undefined,
  current: Readonly<Record<string, string | number | boolean>>,
): ParamControl[] {
  if (capability === undefined) return []
  return capability.params.map((param) => {
    const value = current[param.id]
    const text = value === undefined ? param.default ?? '' : String(value)
    const options = param.options === undefined ? undefined : [...param.options]
    // A value the catalog does not list still shows, so the user sees what the node actually carries.
    const withCurrent = options === undefined || text === '' || options.includes(text) ? options : [text, ...options]
    return {
      id: param.id,
      title: param.title ?? param.id,
      /* v8 ignore next -- a catalog parameter always declares an enumeration, defaulting, or type */
      /* v8 ignore next -- a catalog parameter always declares an enumeration, defaulting, or type */
      kind: withCurrent === undefined ? (param.type === 'number' ? 'number' : 'text') : 'select',
      value: text,
      ...withCurrent === undefined ? {} : { options: withCurrent },
    }
  })
}


/** A generation update the inspector sends. */
export interface GenOperation {
  readonly op: 'set_gen'
  readonly node: string
  readonly gen: {
    readonly model?: string
    readonly prompt?: string
    readonly params?: Readonly<Record<string, string | number | boolean>>
  }
}

/** Generation fields one media node carries. */
export interface GenNodeLike {
  readonly id: string
  readonly gen?: {
    readonly prompt: string
    readonly model?: string
    readonly params: Readonly<Record<string, string | number | boolean>>
  } | undefined
}

/**
 * Fields one generation update carries.
 * @param change - model, prompt, or parameters the user edited.
 * @returns only the fields the caller defined.
 */
function genFields(change: {
  readonly model?: string | undefined
  readonly prompt?: string | undefined
  readonly params?: Readonly<Record<string, string | number | boolean>> | undefined
}): { model?: string; prompt?: string; params?: Readonly<Record<string, string | number | boolean>> } {
  const gen: { model?: string; prompt?: string; params?: Readonly<Record<string, string | number | boolean>> } = {}
  if (change.model !== undefined) gen.model = change.model
  if (change.prompt !== undefined) gen.prompt = change.prompt
  if (change.params !== undefined) gen.params = change.params
  return gen
}

/**
 * Build a canvas operation for the supplied generation fields.
 * @param node - Canvas node being inspected or edited.
 * @param change - Generation fields to update.
 * @returns Operation carrying the supplied generation fields.
 */
export function genOperation(
  node: GenNodeLike,
  change: {
    readonly model?: string | undefined
    readonly prompt?: string | undefined
    readonly params?: Readonly<Record<string, string | number | boolean>> | undefined
  },
): GenOperation {
  return {
    op: 'set_gen',
    node: node.id,
    gen: genFields(change),
  }
}

/** One reference image the inspector lists for a node. */
export interface ReferenceItem {
  readonly source: string
  readonly order: number
}


/** Edge fields the reference order reads. */
export interface EdgeLike {
  readonly source: string
  readonly target: string
  readonly role?: string
  readonly order?: number
}

/**
 * List a node's reference inputs in ascending reference order.
 * @param document - Canvas document before the applied edit.
 * @param nodeId - Node whose reference inputs are requested.
 * @returns Reference source IDs and their order values.
 */
export function orderedRefs(document: { readonly edges: readonly EdgeLike[] }, nodeId: string): ReferenceItem[] {
  return document.edges
    .filter(edge => edge.target === nodeId && edge.role === 'ref')
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map(edge => ({ source: edge.source, order: edge.order ?? 0 }))
}

/**
 * Source of one frame slot.
 * @param document - canvas document.
 * @param nodeId - video node.
 * @param role - `first_frame` or `last_frame`.
 * @returns the image node id, when the slot is set.
 */
export function frameOf(
  document: { readonly edges: readonly { readonly source: string; readonly target: string; readonly role?: string }[] },
  nodeId: string,
  role: 'first_frame' | 'last_frame',
): string | undefined {
  return document.edges.find(edge => edge.target === nodeId && edge.role === role)?.source
}

/**
 * Operations that put the references in one order.
 * @param nodeId - media node.
 * @param sources - sources in the new order.
 * @returns the reorder operation.
 */
export function reorderOperation(
  nodeId: string,
  sources: readonly string[],
): { readonly op: 'reorder_refs'; readonly node: string; readonly sources: readonly string[] } {
  return { op: 'reorder_refs', node: nodeId, sources }
}
