/** Undo and redo for the edits this tab applies, expressed as the operations that restore the previous state. */
import type { CanvasDocument, CanvasNode, CanvasOperation, Shot } from '@deepseek-ai/dsh-canvas/client'

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

/** `after` naming the shot before an insertion point, when there is one. */
function afterOf(shots: readonly Shot[], index: number): { readonly after?: Shot['id'] } {
  const previous = index > 0 ? shots[index - 1]?.id : undefined
  return previous === undefined ? {} : { after: previous }
}

/** Inverse of one operation, or undefined when the edit cannot be expressed backwards. */
function inverseOf(document: CanvasDocument, operation: CanvasOperation): CanvasOperation | undefined {
  switch (operation.op) {
    case 'move': {
      const node = nodeOf(document, operation.node)
      return node === undefined ? undefined : { op: 'move', node: operation.node, x: node.x, y: node.y }
    }
    case 'resize': {
      const node = nodeOf(document, operation.node)
      return node === undefined ? undefined : { op: 'resize', node: operation.node, width: node.width, height: node.height }
    }
    case 'set_version': {
      const node = nodeOf(document, operation.node)
      return node?.activeVersion === undefined ? undefined : { op: 'set_version', node: operation.node, version: node.activeVersion }
    }
    case 'set_gen': {
      const node = nodeOf(document, operation.node)
      return node?.gen === undefined ? undefined : { op: 'set_gen', node: operation.node, gen: node.gen }
    }
    case 'set_text': {
      const node = nodeOf(document, operation.node)
      const text = node?.versions?.find(version => version.id === node.activeVersion)?.text
      return text === undefined ? undefined : { op: 'set_text', node: operation.node, text }
    }
    case 'set_shots':
    case 'update_shot': {
      const node = nodeOf(document, operation.node)
      return node === undefined ? undefined : { op: 'set_shots', node: operation.node, shots: shotsOf(node) }
    }
    case 'insert_shot':
      return { op: 'remove_shot', node: operation.node, shot: '' }
    case 'remove_shot': {
      const node = nodeOf(document, operation.node)
      const index = shotsOf(node).findIndex(shot => shot.id === operation.shot)
      const shot = shotsOf(node)[index]
      if (shot === undefined || node === undefined) return undefined
      const { id, ...rest } = shot
      void id
      return { op: 'insert_shot', node: node.id, ...afterOf(shotsOf(node), index), shot: rest }
    }
    case 'move_shot': {
      const node = nodeOf(document, operation.node)
      const shots = shotsOf(node)
      const index = shots.findIndex(shot => shot.id === operation.shot)
      if (index < 0) return undefined
      return { op: 'move_shot', node: operation.node, shot: operation.shot, ...afterOf(shots, index) }
    }
    case 'connect':
      return { op: 'disconnect', from: operation.from, to: operation.to, ...operation.role === undefined ? {} : { role: operation.role } }
    case 'disconnect': {
      const edge = document.edges.find(candidate => candidate.source === operation.from
        && candidate.target === operation.to
        && (operation.role === undefined || candidate.role === operation.role))
      if (edge === undefined) return undefined
      return {
        op: 'connect', from: edge.source, to: edge.target, kind: edge.kind,
        ...edge.role === undefined ? {} : { role: edge.role },
        ...edge.order === undefined ? {} : { order: edge.order },
      }
    }
    case 'group':
      // The new group's id is only known after the Host applies the edit, so grouping is not undoable here.
      return undefined
    case 'ungroup': {
      const group = nodeOf(document, operation.node)
      if (group === undefined || group.type !== 'group') return undefined
      const members = document.nodes.filter(node => node.group === group.id).map(node => node.id)
      return members.length === 0 ? undefined : { op: 'group', title: group.title, nodes: members }
    }
    case 'reorder_refs': {
      const node = nodeOf(document, operation.node)
      if (node === undefined) return undefined
      const sources = document.edges
        .filter(edge => edge.target === node.id && edge.role === 'ref')
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .map(edge => edge.source)
      return { op: 'reorder_refs', node: node.id, sources }
    }
    case 'update':
    case 'add':
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
export function invertOperations(document: CanvasDocument, operations: readonly CanvasOperation[]): CanvasOperation[] | undefined {
  const inverse: CanvasOperation[] = []
  for (const operation of [...operations].reverse()) {
    const opposite = inverseOf(document, operation)
    if (opposite === undefined) return undefined
    inverse.push(opposite)
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
   * @param operations - operations the edit applied.
   * @param label - label the toolbar shows.
   * @returns whether the edit can be undone.
   */
  record(document: CanvasDocument, operations: readonly CanvasOperation[], label: string): boolean {
    if (operations.length === 0) return false
    const inverse = invertOperations(document, operations)
    if (inverse === undefined) {
      this.undoStack.length = 0
      this.redoStack.length = 0
      return false
    }
    this.undoStack.push({ label, operations, inverse })
    this.redoStack = []
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
