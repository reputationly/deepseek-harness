/** Undo and redo for the edits this tab applies, expressed as the operations that restore the previous state. */
import type { CanvasDocument, CanvasNode, CanvasOperation, Shot } from '@deepseek-ai/dsh-canvas/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasNodeId } from '@deepseek-ai/dsh-canvas/client'

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
function inverseOf(document: CanvasDocument, operation: CanvasOperation): CanvasOperation[] | undefined {
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
      return [{ op: 'ungroup', node: brandString<CanvasNodeId>(`g${String(document.nextId)}`) }]
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
      return [{ op: 'remove', node: brandString<CanvasNodeId>(`n${String(document.nextId)}`) }]
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
export function invertOperations(document: CanvasDocument, operations: readonly CanvasOperation[]): CanvasOperation[] | undefined {
  const inverse: CanvasOperation[] = []
  let skipNext = false
  const reversed = [...operations].reverse()
  for (const [index, operation] of reversed.entries()) {
    if (skipNext) {
      skipNext = false
      continue
    }
    const previous = index + 1 < reversed.length ? reversed[index + 1] : undefined
    if (operation.op === 'move_shot' && previous?.op === 'move_shot'
      && operation.shot === previous.after && operation.after === previous.shot) {
      const shots = shotsOf(nodeOf(document, previous.node))
      const shotIndex = shots.findIndex(shot => shot.id === previous.shot)
      const predecessor = shotIndex > 0 ? shots[shotIndex - 1] : undefined
      if (shots[0]?.id !== previous.after || predecessor === undefined) return undefined
      inverse.push({ op: 'move_shot', node: previous.node, shot: previous.shot, after: predecessor.id })
      skipNext = true
      continue
    }
    const opposite = inverseOf(document, operation)
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
