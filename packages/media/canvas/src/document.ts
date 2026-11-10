/**
 * Parsing and validation of the persisted canvas document.
 * @module
 */

import type { CanvasDocument, CanvasEdge, CanvasNode, CanvasNodeType } from './types.ts'

/** Raised when a persisted document cannot be trusted; the file is left untouched. */
export class CanvasCorruptError extends Error {
  /** @param reason - what made the document unusable. */
  constructor(readonly reason: string) {
    super(`canvas document is corrupt: ${reason}`)
    this.name = 'CanvasCorruptError'
  }
}

/** The canvas of a project that has none yet. */
export const EMPTY_CANVAS: CanvasDocument = { version: 1, nextId: 1, nodes: [], edges: [] }

const NODE_TYPES: readonly CanvasNodeType[] = ['image', 'video', 'audio', 'text', 'group']

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CanvasCorruptError(`${what} is not an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new CanvasCorruptError(`${what} is not a string`)
  return value
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CanvasCorruptError(`${what} is not a finite number`)
  return value
}

function optionalText(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : text(value, what)
}

function parseNode(value: unknown, index: number): CanvasNode {
  const raw = record(value, `nodes[${String(index)}]`)
  const id = text(raw.id, `nodes[${String(index)}].id`)
  const type = text(raw.type, `node ${id} type`)
  if (!NODE_TYPES.includes(type as CanvasNodeType)) throw new CanvasCorruptError(`node ${id} has unknown type ${type}`)
  const path = optionalText(raw.path, `node ${id} path`)
  const body = optionalText(raw.text, `node ${id} text`)
  const prompt = optionalText(raw.prompt, `node ${id} prompt`)
  const model = optionalText(raw.model, `node ${id} model`)
  const group = optionalText(raw.group, `node ${id} group`)
  return {
    id,
    type: type as CanvasNodeType,
    title: text(raw.title, `node ${id} title`),
    x: finite(raw.x, `node ${id} x`),
    y: finite(raw.y, `node ${id} y`),
    width: finite(raw.width, `node ${id} width`),
    height: finite(raw.height, `node ${id} height`),
    ...path === undefined ? {} : { path },
    ...body === undefined ? {} : { text: body },
    ...prompt === undefined ? {} : { prompt },
    ...model === undefined ? {} : { model },
    ...group === undefined ? {} : { group },
    ...raw.placed === true ? { placed: true } : {},
  }
}

function parseEdge(value: unknown, index: number): CanvasEdge {
  const raw = record(value, `edges[${String(index)}]`)
  const source = text(raw.source, `edges[${String(index)}].source`)
  const target = text(raw.target, `edges[${String(index)}].target`)
  const kind = text(raw.kind, `edge ${source}->${target} kind`)
  if (kind !== 'derivation' && kind !== 'reference') throw new CanvasCorruptError(`edge ${source}->${target} has unknown kind ${kind}`)
  return { id: `${source}->${target}`, source, target, kind }
}

/**
 * Check the invariants every reader relies on.
 * @param document - document to check.
 * @throws {@link CanvasCorruptError} on a duplicate id, a dangling edge or group reference, or a nested group.
 */
export function assertCanvas(document: CanvasDocument): void {
  const byId = new Map<string, CanvasNode>()
  for (const node of document.nodes) {
    if (byId.has(node.id)) throw new CanvasCorruptError(`duplicate node id ${node.id}`)
    byId.set(node.id, node)
  }
  for (const node of document.nodes) {
    if (node.group === undefined) continue
    if (node.type === 'group') throw new CanvasCorruptError(`group ${node.id} is nested in ${node.group}`)
    if (byId.get(node.group)?.type !== 'group') throw new CanvasCorruptError(`node ${node.id} names missing group ${node.group}`)
  }
  const edges = new Set<string>()
  for (const edge of document.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) throw new CanvasCorruptError(`edge ${edge.id} names a missing node`)
    if (edges.has(edge.id)) throw new CanvasCorruptError(`duplicate edge ${edge.id}`)
    edges.add(edge.id)
  }
}

/**
 * Parse persisted canvas text.
 * @param source - file content.
 * @returns the validated document.
 * @throws {@link CanvasCorruptError} when the text is not a valid version-1 canvas.
 */
export function parseCanvas(source: string): CanvasDocument {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error: unknown) {
    throw new CanvasCorruptError(error instanceof Error ? error.message : 'invalid JSON')
  }
  const raw = record(value, 'document')
  if (raw.version !== 1) throw new CanvasCorruptError(`unsupported version ${JSON.stringify(raw.version)}`)
  if (!Array.isArray(raw.nodes)) throw new CanvasCorruptError('nodes is not an array')
  if (!Array.isArray(raw.edges)) throw new CanvasCorruptError('edges is not an array')
  const nextId = finite(raw.nextId, 'nextId')
  if (!Number.isInteger(nextId) || nextId < 1) throw new CanvasCorruptError('nextId is not a positive integer')
  const document: CanvasDocument = {
    version: 1,
    nextId,
    nodes: raw.nodes.map(parseNode),
    edges: raw.edges.map(parseEdge),
  }
  assertCanvas(document)
  return document
}

/**
 * Serialize a document for the canvas file.
 * @param document - validated document.
 * @returns pretty-printed JSON ending in a newline.
 */
export function serializeCanvas(document: CanvasDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}
