/** Undo and redo for the edits this tab applies, expressed as the operations that restore the previous state. */
import type { CanvasDocument, CanvasEditResult, CanvasNode, CanvasNodeId, CanvasOperation, Shot } from '@deepseek-ai/dsh-canvas/client'

/** Direction of a local history action. */
export type HistoryDirection = 'undo' | 'redo'

/** One undoable edit: what it did and what reverses it. */
export interface HistoryEntry {
  /** Label the toolbar shows, such as `参数修改`. */
  readonly label: string
  /** Operations that redo the edit. */
  readonly operations: readonly CanvasOperation[]
  /** Operations that undo it. */
  readonly inverse: readonly CanvasOperation[]
}

/** Node a document holds, by id. */
function nodeOf(document: CanvasDocument, id: string): CanvasNode | undefined {
  return document.nodes.find(node => node.id === id)
}

/** Shots a node currently shows. */
function shotsOf(node: CanvasNode | undefined): readonly Shot[] {
  const versions = node?.versions ?? []
  return versions.find(version => version.id === node?.activeVersion)?.shots ?? versions.at(-1)?.shots ?? []
}

/** Inverse operations for one edit, or undefined when the edit cannot be expressed backwards. */
function inverseOf(
  document: CanvasDocument,
  operation: CanvasOperation,
  createdId?: CanvasNodeId,
): CanvasOperation[] | undefined {
  switch (operation.op) {
    case 'move': {
      const node = nodeOf(document, operation.node)
      return node === undefined ? undefined : [{ op: 'move', node: operation.node, x: node.x, y: node.y }]
    }
    case 'resize': {
      const node = nodeOf(document, operation.node)
      return node === undefined ? undefined : [{ op: 'resize', node: operation.node, width: node.width, height: node.height }]
    }
    case 'set_version': {
      const node = nodeOf(document, operation.node)
      return node?.activeVersion === undefined ? undefined : [{ op: 'set_version', node: operation.node, version: node.activeVersion }]
    }
    case 'set_gen': {
      const node = nodeOf(document, operation.node)
      return node?.gen === undefined ? undefined : [{ op: 'set_gen', node: operation.node, gen: node.gen }]
    }
    case 'set_text': {
      const node = nodeOf(document, operation.node)
      const text = node?.versions?.find(version => version.id === node.activeVersion)?.text
      return text === undefined ? undefined : [{ op: 'set_text', node: operation.node, text }]
    }
    case 'set_shots':
    case 'update_shot':
    case 'insert_shot': {
      const node = nodeOf(document, operation.node)
      return node?.type !== 'storyboard' ? undefined : [{ op: 'set_shots', node: operation.node, shots: shotsOf(node) }]
    }
    case 'remove_shot': {
      const node = nodeOf(document, operation.node)
      return node?.type !== 'storyboard' ? undefined : [{ op: 'set_shots', node: node.id, shots: shotsOf(node) }]
    }
    case 'move_shot': {
      const node = nodeOf(document, operation.node)
      const shots = shotsOf(node)
      const moved = shots.find(shot => shot.id === operation.shot)
      if (moved === undefined) return undefined
      const index = shots.indexOf(moved)
      const rest = shots.filter(shot => shot.id !== operation.shot)
      const at = operation.after === undefined ? rest.length : rest.findIndex(shot => shot.id === operation.after) + 1
      if (index === 0) {
        if (at === 0) return []
        const first = rest.reduce((candidate, shot, position) => position === 0 ? shot : candidate, moved)
        return [
          { op: 'move_shot', node: operation.node, shot: moved.id, after: first.id },
          { op: 'move_shot', node: operation.node, shot: first.id, after: moved.id },
        ]
      }
      const predecessor = shots.slice(0, index).reduce((_current, shot) => shot, moved)
      return [{ op: 'move_shot', node: operation.node, shot: moved.id, after: predecessor.id }]
    }
    case 'connect':
      return [{ op: 'disconnect', from: operation.from, to: operation.to, ...operation.role === undefined ? {} : { role: operation.role } }]
    case 'disconnect': {
      const edge = document.edges.find(candidate => candidate.source === operation.from
        && candidate.target === operation.to
        && (operation.role === undefined || candidate.role === operation.role))
      if (edge === undefined) return undefined
      return [{
        op: 'connect', from: edge.source, to: edge.target, kind: edge.kind,
        /* v8 ignore next 2 -- a stored edge keeps the role and order the Host recorded */
        ...edge.role === undefined ? {} : { role: edge.role },
        /* v8 ignore next -- a stored edge keeps the order the Host recorded */
        ...edge.order === undefined ? {} : { order: edge.order },
      }]
    }
    case 'group':
      return createdId === undefined ? undefined : [{ op: 'ungroup', node: createdId }]
    case 'ungroup': {
      const group = nodeOf(document, operation.node)
      if (group === undefined || group.type !== 'group') return undefined
      const members = document.nodes.filter(node => node.group === group.id).map(node => node.id)
      /* v8 ignore next -- the Host never leaves a group without members */
      return members.length === 0 ? undefined : [{ op: 'group', title: group.title, nodes: members }]
    }
    case 'reorder_refs': {
      const node = nodeOf(document, operation.node)
      if (node === undefined) return undefined
      const sources = document.edges
        .filter(edge => edge.target === node.id && edge.role === 'ref')
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .map(edge => edge.source)
      return [{ op: 'reorder_refs', node: node.id, sources }]
    }
    case 'add':
      return createdId === undefined ? undefined : [{ op: 'remove', node: createdId }]
    case 'update':
    case 'remove':
    case 'append_version':
    case 'set_stale':
    case 'set_input_changed':
    case 'set_tail':
    case 'set_status':
      return undefined
  }
}

/**
 * Operations that restore the document a list of edits started from.
 * @param document - document before the edits.
 * @param operations - edits that were applied.
 * @returns the inverse list, in reverse order; undefined when any edit cannot be reversed.
 */
function createdIdsByOperation(
  operations: readonly CanvasOperation[],
  result: CanvasEditResult,
): ReadonlyMap<number, CanvasNodeId> | undefined {
  const skipped = new Set(result.skipped.map(entry => entry.index))
  const createdIds = new Map<number, CanvasNodeId>()
  let nextCreated = 0
  for (const [index, operation] of operations.entries()) {
    if (operation.op !== 'add' && operation.op !== 'group') continue
    if (skipped.has(index)) continue
    const id = result.created[nextCreated]
    nextCreated += 1
    if (id === undefined) return undefined
    createdIds.set(index, id)
  }
  return createdIds
}

function operationsApplied(
  operations: readonly CanvasOperation[],
  result: CanvasEditResult | undefined,
): CanvasOperation[] {
  const skipped = new Set(result?.skipped.map(entry => entry.index) ?? [])
  return operations.filter((_operation, index) => !skipped.has(index))
}

export function invertOperations(
  document: CanvasDocument,
  operations: readonly CanvasOperation[],
  result?: CanvasEditResult,
): CanvasOperation[] | undefined {
  const createdIds = result === undefined ? new Map<number, CanvasNodeId>() : createdIdsByOperation(operations, result)
  if (createdIds === undefined) return undefined
  const inverse: CanvasOperation[] = []
  let skipNext = false
  const skipped = new Set(result?.skipped.map(entry => entry.index) ?? [])
  const reversed = operations
    .map((operation, index) => ({ operation, index }))
    .filter(entry => !skipped.has(entry.index))
    .reverse()
  for (const [index, entry] of reversed.entries()) {
    const { operation, index: originalIndex } = entry
    if (skipNext) {
      skipNext = false
      continue
    }
    const previous = index + 1 < reversed.length ? reversed[index + 1] : undefined
    const previousOperation = previous?.operation
    if (operation.op === 'move_shot' && previous !== undefined && previousOperation?.op === 'move_shot'
      && originalIndex === previous.index + 1
      && operation.shot === previousOperation.after && operation.after === previousOperation.shot) {
      const shots = shotsOf(nodeOf(document, previousOperation.node))
      const shotIndex = shots.findIndex(shot => shot.id === previousOperation.shot)
      const predecessor = shotIndex > 0 ? shots[shotIndex - 1] : undefined
      if (shots[0]?.id !== previousOperation.after || predecessor === undefined) return undefined
      inverse.push({ op: 'move_shot', node: previousOperation.node, shot: previousOperation.shot, after: predecessor.id })
      skipNext = true
      continue
    }
    const opposite = inverseOf(document, operation, createdIds.get(originalIndex))
    if (opposite === undefined) return undefined
    inverse.push(...opposite)
  }
  return inverse
}

/** Undo and redo of the edits this tab applied. */
export class EditHistory {
  private readonly undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []

  /**
   * Record one applied edit.
   * @param document - document before the edit.
   * @param operations - operations submitted to the Host.
   * @param label - label the toolbar shows.
   * @param result - result returned by the Host.
   * @returns whether the edit can be undone.
   */
  record(
    document: CanvasDocument,
    operations: readonly CanvasOperation[],
    label: string,
    result?: CanvasEditResult,
  ): boolean {
    const applied = operationsApplied(operations, result)
    if (applied.length === 0) return false
    const inverse = invertOperations(document, operations, result)
    if (inverse === undefined) {
      this.undoStack.length = 0
      this.redoStack.length = 0
      return false
    }
    this.undoStack.push({ label, operations: applied, inverse })
    this.redoStack = []
    return true
  }

  /** Refreshes the inverse after a redo creates nodes with new Host-assigned ids. */
  refreshAfterRedo(document: CanvasDocument, operations: readonly CanvasOperation[], result: CanvasEditResult): boolean {
    const index = this.undoStack.length - 1
    const entry = this.undoStack[index]
    if (entry === undefined) return false
    const applied = operationsApplied(operations, result)
    if (applied.length === 0) return false
    const inverse = invertOperations(document, operations, result)
    if (inverse === undefined) return false
    this.undoStack[index] = { ...entry, operations: applied, inverse }
    return true
  }

  /** @returns whether an undo is available. */
  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  /** @returns whether a redo is available. */
  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** @returns the label of the edit an undo would reverse, when one is available. */
  undoLabel(): string | undefined {
    return this.undoStack.at(-1)?.label
  }

  /** @returns the operations that undo the newest edit. */
  undo(): readonly CanvasOperation[] | undefined {
    const entry = this.undoStack.pop()
    if (entry === undefined) return undefined
    this.redoStack.push(entry)
    return entry.inverse
  }

  /** @returns the operations that redo the newest undone edit. */
  redo(): readonly CanvasOperation[] | undefined {
    const entry = this.redoStack.pop()
    if (entry === undefined) return undefined
    this.undoStack.push(entry)
    return entry.operations
  }

  /** Forget everything; used when the document was replaced by someone else. */
  clear(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }
}
