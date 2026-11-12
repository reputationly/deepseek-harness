/**
 * Pure application of an operation list to a canvas document.
 * @module
 */

import { basename } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResolvedConfig } from './config.ts'
import { activeVersionOf, assertCanvas, CanvasCorruptError } from './document.ts'
import { fitGroups, layoutCreated, nodeSize, type DraftNode } from './layout.ts'
import { edgeId, inferRole } from './roles.ts'
import type {
  CanvasDocument, CanvasEdge, CanvasEdgeRole, CanvasEditResult, CanvasNodeId, CanvasNodeType, CanvasOperation,
  CanvasSkippedOperation, DialogueLine, NodeVersion, Shot, ShotId, VersionId,
} from './types.ts'

/** Inputs every operation list needs beyond the document itself. */
export interface ApplyOptions {
  /** Deployment bounds the result must satisfy. */
  readonly limits: ResolvedConfig
  /** Who prompted the change, recorded on the versions it creates. */
  readonly origin?: 'agent' | 'user'
  /** Operations the caller already refused, keyed by list index, with the reason. */
  readonly rejected?: ReadonlyMap<number, string>
  /** Clock used for version timestamps; tests fix it. */
  readonly now?: () => string
}

/** Result of applying one operation list. */
export interface ApplyOutcome {
  readonly document: CanvasDocument
  readonly result: CanvasEditResult
  /** Whether at least one operation changed the document. */
  readonly changed: boolean
}

/** Shot fields a caller may patch, with the id the shot keeps. */
type ShotPatch = Partial<Omit<Shot, 'id'>>

/** A node while one operation list is being applied: its version list always exists. */
type WorkingNode = DraftNode & { versions: readonly NodeVersion[] }

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

/** Next version id for a node: one past the highest `v<k>` it holds. */
function nextVersionId(versions: readonly NodeVersion[]): VersionId {
  let highest = 0
  for (const version of versions) {
    const suffix = Number(version.id.slice(1))
    if (Number.isInteger(suffix) && suffix > highest) highest = suffix
  }
  return brandString<VersionId>(`v${String(highest + 1)}`)
}

function isTextType(type: CanvasNodeType): boolean {
  return type === 'text' || type === 'script'
}

function isMediaType(type: CanvasNodeType): boolean {
  return type === 'image' || type === 'video' || type === 'audio'
}

/**
 * Check a caller's base revision against the document.
 * @param document - current document.
 * @param baseRevision - revision the caller read, or undefined to skip the check.
 * @throws {@link CanvasConflictError} when the document moved past the caller's revision.
 */
export function checkRevision(document: CanvasDocument, baseRevision: number | undefined): void {
  if (baseRevision === undefined || baseRevision === document.revision) return
  throw new CanvasConflictError(baseRevision, document.revision)
}

/** Raised when the document changed since the caller read it; nothing was written. */
export class CanvasConflictError extends Error {
  /**
   * @param expected - revision the caller based the edit on.
   * @param actual - current document revision.
   */
  constructor(readonly expected: number, readonly actual: number) {
    super(`canvas revision is ${String(actual)}, not the ${String(expected)} this edit was based on`)
    this.name = 'CanvasConflictError'
  }
}

/**
 * Apply operations in order. An operation that cannot apply is skipped with a reason and the rest
 * still run.
 * @param document - current validated document.
 * @param operations - ordered operations.
 * @param options - deployment bounds, version origin, caller refusals, and the clock.
 * @returns the next document, the edit result, and whether anything changed.
 */
export function applyOperations(
  document: CanvasDocument,
  operations: readonly CanvasOperation[],
  options: ApplyOptions,
): ApplyOutcome {
  const nodes = new Map<string, WorkingNode>(document.nodes.map(node => [node.id, { ...node, versions: node.versions ?? [] }]))
  const edges = new Map<string, CanvasEdge>(document.edges.map(edge => [edge.id, edge]))
  const refs = new Map<string, CanvasNodeId>()
  const created: CanvasNodeId[] = []
  const skipped: CanvasSkippedOperation[] = []
  const working = new Map<string, NodeVersion>()
  const now = options.now ?? (() => new Date().toISOString())
  const origin = options.origin ?? 'user'
  let nextId = document.nextId
  let applied = 0

  const find = (name: string): WorkingNode => {
    const node = nodes.get(refs.get(name) ?? name)
    if (node === undefined) throw new Skip(`node ${name} does not exist`)
    return node
  }
  const claim = (ref: string | undefined, id: CanvasNodeId): void => {
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
  const dropNode = (id: CanvasNodeId): void => {
    nodes.delete(id)
    for (const edge of [...edges.values()]) if (edge.source === id || edge.target === id) edges.delete(edge.id)
    for (const member of nodes.values()) if (member.group === id) delete member.group
  }
  const setVersion = (node: WorkingNode, version: NodeVersion): void => {
    node.versions = [...node.versions, version]
    node.activeVersion = version.id
    working.set(node.id, version)
  }
  const dropVersions = (node: WorkingNode): void => {
    const versions = node.versions
    const limit = isMediaType(node.type) ? options.limits.versionLimit : options.limits.textVersionLimit
    if (versions.length <= limit) return
    const kept = versions.slice(versions.length - limit)
    const active = activeVersionOf(node)
    if (active !== undefined && !kept.some(version => version.id === active.id)) {
      kept.shift()
      kept.unshift(active)
    }
    node.versions = kept
  }
  const storyboardOf = (node: WorkingNode): Shot[] => {
    const version = activeVersionOf(node)
    if (node.type !== 'storyboard') throw new Skip(`node ${node.id} is not a storyboard`)
    return [...version?.shots ?? []]
  }
  const writeShots = (node: WorkingNode, shots: readonly Shot[]): void => {
    if (shots.length > options.limits.maxShotsPerStoryboard) {
      throw new Skip(`a storyboard holds at most ${String(options.limits.maxShotsPerStoryboard)} shots`)
    }
    const current = working.get(node.id)
    if (current !== undefined) {
      const next = { ...current, shots }
      working.set(node.id, next)
      node.versions = node.versions.map(held => held.id === current.id ? next : held)
      return
    }
    setVersion(node, { id: nextVersionId(node.versions), shots, createdAt: now(), origin })
  }
  const shotAt = (shots: readonly Shot[], id: string): number => {
    const index = shots.findIndex(shot => shot.id === id)
    if (index < 0) throw new Skip(`shot ${id} does not exist`)
    return index
  }
  const shotById = (shots: readonly Shot[], id: string): Shot => {
    const shot = shots.find(entry => entry.id === id)
    if (shot === undefined) throw new Skip(`shot ${id} does not exist`)
    return shot
  }
  const withShot = (shots: readonly Shot[], index: number, patch: ShotPatch): readonly Shot[] =>
    shots.map((shot, at) => at === index ? { ...shot, ...patch } : shot)
  const orderOf = (role: CanvasEdgeRole, target: string): number => {
    const held = [...edges.values()].filter(edge => edge.target === target && edge.role === role).map(edge => edge.order ?? 0)
    return held.length === 0 ? 0 : Math.max(...held) + 1
  }

  const run = (operation: CanvasOperation): void => {
    switch (operation.op) {
      case 'add': {
        checkRef(operation.ref)
        const group = operation.group === undefined ? undefined : joinGroup(operation.group)
        const content = isTextType(operation.type) ? operation.text : operation.path
        const needsContent = operation.type !== 'storyboard' && operation.type !== 'timeline'
        if (needsContent && (content === undefined || content === '')) {
          throw new Skip(isTextType(operation.type) ? `a ${operation.type} node needs text` : `${operation.type === 'image' || operation.type === 'audio' ? 'an' : 'a'} ${operation.type} node needs path`)
        }
        if (operation.gen !== undefined && operation.gen.prompt.length > options.limits.maxPromptLength) {
          throw new Skip(`prompt exceeds ${String(options.limits.maxPromptLength)} characters`)
        }
        if (operation.shots !== undefined && operation.shots.length > options.limits.maxShotsPerStoryboard) {
          throw new Skip(`a storyboard holds at most ${String(options.limits.maxShotsPerStoryboard)} shots`)
        }
        const id = brandString<CanvasNodeId>(`n${String(nextId++)}`)
        const version: NodeVersion = {
          id: brandString<VersionId>('v1'),
          ...content === undefined || content === '' ? {} : isTextType(operation.type) ? { text: content } : { path: content },
          ...operation.shots === undefined ? {} : { shots: operation.shots },
          ...operation.gen === undefined ? {} : { prompt: operation.gen.prompt },
          ...operation.gen?.model === undefined ? {} : { model: operation.gen.model },
          ...operation.gen === undefined ? {} : { params: operation.gen.params },
          createdAt: now(),
          origin,
        }
        const title = operation.title ?? (content === undefined || content === '' ? operation.type : isTextType(operation.type) ? content.slice(0, 24) : basename(content))
        nodes.set(id, {
          id, type: operation.type, title, x: 0, y: 0, ...nodeSize(operation.type),
          versions: [version],
          activeVersion: version.id,
          ...operation.gen === undefined ? {} : { gen: operation.gen },
          ...operation.bible === undefined ? {} : { bible: operation.bible },
          ...group === undefined ? {} : { group: brandString<CanvasNodeId>(group) },
        })
        claim(operation.ref, id)
        return
      }
      case 'remove': {
        dropNode(find(operation.node).id)
        return
      }
      case 'update': {
        const node = find(operation.node)
        if (operation.text !== undefined && !isTextType(node.type)) throw new Skip(`node ${node.id} is not a text node`)
        if (operation.path !== undefined && !isMediaType(node.type)) throw new Skip(`node ${node.id} has no file`)
        if (operation.title !== undefined) node.title = operation.title
        if (operation.text !== undefined) {
          setVersion(node, { id: nextVersionId(node.versions), text: operation.text, createdAt: now(), origin })
        }
        if (operation.path !== undefined) {
          setVersion(node, { id: nextVersionId(node.versions), path: operation.path, createdAt: now(), origin })
        }
        return
      }
      case 'set_gen': {
        const node = find(operation.node)
        if (node.type !== 'image' && node.type !== 'video' && node.type !== 'audio') throw new Skip(`node ${node.id} does not generate media`)
        const { params, ...rest } = operation.gen
        const merged = { ...node.gen, ...rest } as typeof node.gen
        const nextParams: Record<string, string | number | boolean> = {}
        for (const [key, value] of Object.entries({ ...node.gen?.params, ...params })) {
          if (value !== null) nextParams[key] = value
        }
        const prompt = operation.gen.prompt ?? node.gen?.prompt ?? ''
        if (prompt.length > options.limits.maxPromptLength) throw new Skip(`prompt exceeds ${String(options.limits.maxPromptLength)} characters`)
        node.gen = { ...merged, kind: merged?.kind ?? (node.type === 'audio' ? 'speech' : node.type), prompt, params: nextParams }
        return
      }
      case 'set_text': {
        const node = find(operation.node)
        if (!isTextType(node.type)) throw new Skip(`node ${node.id} is not a text node`)
        const current = working.get(node.id)
        if (current !== undefined) {
          const next = { ...current, text: operation.text }
          working.set(node.id, next)
          node.versions = node.versions.map(held => held.id === current.id ? next : held)
          return
        }
        setVersion(node, { id: nextVersionId(node.versions), text: operation.text, createdAt: now(), origin })
        return
      }
      case 'set_shots': {
        writeShots(find(operation.node), operation.shots)
        return
      }
      case 'update_shot': {
        const node = find(operation.node)
        const shots = storyboardOf(node)
        const index = shotAt(shots, operation.shot)
        writeShots(node, withShot(shots, index, operation.patch))
        return
      }
      case 'insert_shot': {
        const node = find(operation.node)
        const shots = storyboardOf(node)
        const id = `s${String(shots.reduce((highest, shot) => Math.max(highest, Number(shot.id.slice(1)) || 0), 0) + 1)}`
        const dialogue: readonly DialogueLine[] = operation.shot.dialogue
        const inserted: Shot = { ...operation.shot, id: brandString<ShotId>(id), dialogue }
        const at = operation.after === undefined ? shots.length : shotAt(shots, operation.after) + 1
        writeShots(node, [...shots.slice(0, at), inserted, ...shots.slice(at)])
        return
      }
      case 'remove_shot': {
        const node = find(operation.node)
        const shots = storyboardOf(node)
        writeShots(node, shots.filter((_shot, at) => at !== shotAt(shots, operation.shot)))
        return
      }
      case 'move_shot': {
        const node = find(operation.node)
        const shots = storyboardOf(node)
        const moved = shotById(shots, operation.shot)
        const rest = shots.filter(shot => shot.id !== moved.id)
        const at = operation.after === undefined ? rest.length : shotAt(rest, operation.after) + 1
        writeShots(node, [...rest.slice(0, at), moved, ...rest.slice(at)])
        return
      }
      case 'set_version': {
        const node = find(operation.node)
        if (!node.versions.some(version => version.id === operation.version)) throw new Skip(`node ${node.id} has no version ${operation.version}`)
        node.activeVersion = brandString<VersionId>(operation.version)
        return
      }
      case 'append_version': {
        const node = find(operation.node)
        if (node.type === 'group') throw new Skip(`node ${node.id} is a group`)
        const { id, ...body } = operation.version
        setVersion(node, {
          ...body,
          id: id === undefined ? nextVersionId(node.versions) : brandString<VersionId>(id),
          createdAt: body.createdAt ?? now(),
          origin: body.origin ?? origin,
        })
        return
      }
      case 'set_status': {
        const node = find(operation.node)
        if (operation.status === null) delete node.status
        else node.status = operation.status
        return
      }
      case 'connect': {
        const from = find(operation.from)
        const to = find(operation.to)
        if (from.id === to.id) throw new Skip('a node cannot connect to itself')
        if (from.group === to.id || to.group === from.id) throw new Skip('a group cannot connect to its own member')
        if (operation.kind === 'derivation' && operation.role !== undefined) throw new Skip('a derivation edge carries no role')
        const role = operation.kind === 'derivation' ? undefined : operation.role ?? inferRole(from.type, to.type)
        if (operation.kind === 'reference' && role === undefined) throw new Skip(`cannot infer what ${from.id} supplies to ${to.id}`)
        const kind = role === undefined ? 'derivation' : 'reference'
        if (role === 'first_frame' || role === 'last_frame') {
          if (from.type !== 'image' || to.type !== 'video') throw new Skip(`${role} connects an image to a video`)
          const held = [...edges.values()].some(edge => edge.target === to.id && edge.role === role)
          if (held) throw new Skip(`${to.id} already has a ${role}`)
        }
        const id = edgeId(from.id, to.id, role)
        if (edges.has(id)) throw new Skip(role === undefined ? `${from.id} is already connected to ${to.id}` : `${from.id} already supplies ${role} to ${to.id}`)
        if (reaches(edges, to.id, from.id)) throw new Skip(`connecting ${from.id} to ${to.id} would create a cycle`)
        edges.set(id, {
          id, source: from.id, target: to.id,
          ...role === undefined ? { kind: 'derivation' as const } : { kind: 'reference' as const, role },
          ...role !== 'ref' || kind === 'derivation' ? {} : { order: operation.order ?? orderOf(role, to.id) },
        })
        return
      }
      case 'disconnect': {
        const from = find(operation.from)
        const to = find(operation.to)
        if (operation.role === undefined) {
          const held = [...edges.values()].filter(edge => edge.source === from.id && edge.target === to.id)
          if (held.length === 0) throw new Skip(`${from.id} is not connected to ${to.id}`)
          for (const edge of held) edges.delete(edge.id)
          return
        }
        if (!edges.delete(edgeId(from.id, to.id, operation.role))) throw new Skip(`${from.id} does not supply ${operation.role} to ${to.id}`)
        return
      }
      case 'reorder_refs': {
        const node = find(operation.node)
        operation.sources.forEach((source, order) => {
          const id = edgeId(refs.get(source) ?? source, node.id, 'ref')
          const edge = edges.get(id)
          if (edge !== undefined) edges.set(id, { ...edge, order })
        })
        return
      }
      case 'group': {
        checkRef(operation.ref)
        const members = operation.nodes.map(find)
        if (members.length === 0) throw new Skip('a group needs at least one node')
        const nested = members.find(member => member.type === 'group')
        if (nested !== undefined) throw new Skip(`node ${nested.id} is a group; groups do not nest`)
        const id = brandString<CanvasNodeId>(`g${String(nextId++)}`)
        nodes.set(id, {
          id: brandString<CanvasNodeId>(id), type: 'group', title: operation.title ?? 'Group',
          x: 0, y: 0, width: 0, height: 0, versions: [],
          ...operation.sceneOrigin === undefined ? {} : { sceneOrigin: operation.sceneOrigin },
        })
        for (const member of members) member.group = brandString<CanvasNodeId>(id)
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
      default: {
        const unhandled: never = operation
        throw new Error(`canvas: unhandled operation ${JSON.stringify(unhandled)}`)
      }
    }
  }

  operations.forEach((operation, index) => {
    const refused = options.rejected?.get(index)
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
  for (const node of nodes.values()) dropVersions(node)
  layoutCreated(nodes, [...edges.values()], created.filter((id) => {
    const node = nodes.get(id)
    return node !== undefined && node.type !== 'group' && node.placed !== true
  }))
  fitGroups(nodes)

  const next: CanvasDocument = {
    version: 2,
    revision: document.revision + (applied > 0 ? 1 : 0),
    nextId,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  }
  assertCanvas(next)
  if (next.nodes.length > options.limits.maxNodes) throw new CanvasCorruptError(`canvas would hold more than ${String(options.limits.maxNodes)} nodes`)
  if (next.edges.length > options.limits.maxEdges) throw new CanvasCorruptError(`canvas would hold more than ${String(options.limits.maxEdges)} edges`)
  return {
    document: next,
    result: {
      revision: next.revision,
      refs: Object.fromEntries([...refs].filter(([, id]) => nodes.has(id))),
      created: created.filter(id => nodes.has(id)),
      skipped,
    },
    changed: applied > 0,
  }
}
