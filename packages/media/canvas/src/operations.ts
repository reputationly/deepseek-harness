/**
 * Pure application of an operation list to a canvas document.
 * @module
 */

import { basename } from 'node:path'
import { assertCanvas } from './document.ts'
import { fitGroups, layoutCreated, nodeSize, type DraftNode } from './layout.ts'
import type { CanvasDocument, CanvasEdge, CanvasEditResult, CanvasOperation, CanvasSkippedOperation } from './types.ts'

/** Result of applying one operation list. */
export interface ApplyOutcome {
  readonly document: CanvasDocument
  readonly result: CanvasEditResult
  /** Whether at least one operation changed the document. */
  readonly changed: boolean
}

class Skip extends Error {}

function reaches(edges: ReadonlyMap<string, CanvasEdge>, from: string, to: string): boolean {
  const seen = new Set<string>()
  const queue = [from]
  for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
    if (current === to) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const edge of edges.values()) if (edge.source === current) queue.push(edge.target)
  }
  return false
}

/**
 * Apply operations in order. An operation that cannot apply is skipped with a reason and the rest
 * still run.
 * @param document - current validated document.
 * @param operations - ordered operations.
 * @param rejected - operations the caller already refused, keyed by list index, with the reason.
 * @returns the next document, the edit result, and whether anything changed.
 */
export function applyOperations(
  document: CanvasDocument,
  operations: readonly CanvasOperation[],
  rejected: ReadonlyMap<number, string> = new Map(),
): ApplyOutcome {
  const nodes = new Map<string, DraftNode>(document.nodes.map(node => [node.id, { ...node }]))
  const edges = new Map<string, CanvasEdge>(document.edges.map(edge => [edge.id, edge]))
  const refs = new Map<string, string>()
  const created: string[] = []
  const skipped: CanvasSkippedOperation[] = []
  let nextId = document.nextId
  let applied = 0

  const find = (name: string): DraftNode => {
    const node = nodes.get(refs.get(name) ?? name)
    if (node === undefined) throw new Skip(`node ${name} does not exist`)
    return node
  }
  const claim = (ref: string | undefined, id: string): void => {
    if (ref !== undefined) refs.set(ref, id)
    created.push(id)
  }
  const checkRef = (ref: string | undefined): void => {
    if (ref !== undefined && (refs.has(ref) || nodes.has(ref))) throw new Skip(`ref ${ref} is already in use`)
  }
  const joinGroup = (name: string): string => {
    const group = find(name)
    if (group.type !== 'group') throw new Skip(`node ${name} is not a group`)
    return group.id
  }
  const dropNode = (id: string): void => {
    nodes.delete(id)
    for (const edge of [...edges.values()]) if (edge.source === id || edge.target === id) edges.delete(edge.id)
    for (const member of nodes.values()) if (member.group === id) delete member.group
  }

  const run = (operation: CanvasOperation): void => {
    switch (operation.op) {
      case 'add': {
        checkRef(operation.ref)
        const group = operation.group === undefined ? undefined : joinGroup(operation.group)
        const content = operation.type === 'text' ? operation.text : operation.path
        if (content === undefined || content === '') {
          throw new Skip(operation.type === 'text' ? 'a text node needs text' : `${operation.type === 'image' ? 'an' : 'a'} ${operation.type} node needs path`)
        }
        const id = `n${String(nextId++)}`
        const title = operation.title ?? (operation.type === 'text' ? content.slice(0, 24) : basename(content))
        nodes.set(id, {
          id, type: operation.type, title, x: 0, y: 0, ...nodeSize(operation.type),
          ...operation.type === 'text' ? { text: content } : { path: content },
          ...operation.prompt === undefined ? {} : { prompt: operation.prompt },
          ...operation.model === undefined ? {} : { model: operation.model },
          ...group === undefined ? {} : { group },
        })
        claim(operation.ref, id)
        return
      }
      case 'update': {
        const node = find(operation.node)
        if (operation.text !== undefined && node.type !== 'text') throw new Skip(`node ${node.id} is not a text node`)
        if (operation.path !== undefined && (node.type === 'text' || node.type === 'group')) throw new Skip(`node ${node.id} has no file`)
        if (operation.title !== undefined) node.title = operation.title
        if (operation.text !== undefined) node.text = operation.text
        if (operation.path !== undefined) node.path = operation.path
        return
      }
      case 'remove': {
        dropNode(find(operation.node).id)
        return
      }
      case 'connect': {
        const from = find(operation.from)
        const to = find(operation.to)
        const id = `${from.id}->${to.id}`
        if (from.id === to.id) throw new Skip('a node cannot connect to itself')
        if (from.group === to.id || to.group === from.id) throw new Skip('a group cannot connect to its own member')
        if (edges.has(id)) throw new Skip(`${from.id} is already connected to ${to.id}`)
        if (reaches(edges, to.id, from.id)) throw new Skip(`connecting ${from.id} to ${to.id} would create a cycle`)
        edges.set(id, { id, source: from.id, target: to.id, kind: operation.kind ?? 'reference' })
        return
      }
      case 'disconnect': {
        const id = `${find(operation.from).id}->${find(operation.to).id}`
        if (!edges.delete(id)) throw new Skip(`${id} is not connected`)
        return
      }
      case 'group': {
        checkRef(operation.ref)
        const members = operation.nodes.map(find)
        if (members.length === 0) throw new Skip('a group needs at least one node')
        const nested = members.find(member => member.type === 'group')
        if (nested !== undefined) throw new Skip(`node ${nested.id} is a group; groups do not nest`)
        const id = `g${String(nextId++)}`
        nodes.set(id, { id, type: 'group', title: operation.title ?? 'Group', x: 0, y: 0, width: 0, height: 0 })
        for (const member of members) member.group = id
        claim(operation.ref, id)
        return
      }
      case 'ungroup': {
        const group = find(operation.node)
        if (group.type !== 'group') throw new Skip(`node ${group.id} is not a group`)
        dropNode(group.id)
        return
      }
      case 'move': {
        const node = find(operation.node)
        const dx = operation.x - node.x
        const dy = operation.y - node.y
        const moved = node.type === 'group' ? [...nodes.values()].filter(member => member.group === node.id) : [node]
        for (const member of moved) {
          member.x += dx
          member.y += dy
          member.placed = true
        }
        return
      }
      case 'resize': {
        const node = find(operation.node)
        if (node.type === 'group') throw new Skip('a group frame follows its members')
        if (operation.width <= 0 || operation.height <= 0) throw new Skip('width and height must be positive')
        node.width = operation.width
        node.height = operation.height
        return
      }
    }
  }

  operations.forEach((operation, index) => {
    const refused = rejected.get(index)
    if (refused !== undefined) {
      skipped.push({ index, op: operation.op, reason: refused })
      return
    }
    try {
      run(operation)
      applied += 1
    } catch (error: unknown) {
      if (!(error instanceof Skip)) throw error
      skipped.push({ index, op: operation.op, reason: error.message })
    }
  })

  for (const group of [...nodes.values()]) {
    if (group.type === 'group' && ![...nodes.values()].some(node => node.group === group.id)) dropNode(group.id)
  }
  layoutCreated(nodes, [...edges.values()], created.filter((id) => {
    const node = nodes.get(id)
    return node !== undefined && node.type !== 'group' && node.placed !== true
  }))
  fitGroups(nodes)

  const next: CanvasDocument = { version: 1, nextId, nodes: [...nodes.values()], edges: [...edges.values()] }
  assertCanvas(next)
  return {
    document: next,
    result: {
      refs: Object.fromEntries([...refs].filter(([, id]) => nodes.has(id))),
      created: created.filter(id => nodes.has(id)),
      skipped,
    },
    changed: applied > 0,
  }
}
