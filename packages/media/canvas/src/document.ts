/**
 * Parsing, migration, and validation of the persisted canvas document.
 * @module
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { ResolvedConfig } from './config.ts'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type {
  BibleEntryId, CanvasDocument, CanvasEdge, CanvasEdgeKind, CanvasEdgeRole, CanvasNode, CanvasNodeId, CanvasNodeType,
  DialogueId, DialogueLine, ExportRecord, GenerationKind, GenerationSpec, NodeInput, NodeStatus, NodeVersion, Shot, ShotId,
  ShotSize, StillMotion, TimelineRef, VersionId,
} from './types.ts'
import { edgeId, inferRole } from './roles.ts'

/** Raised when a persisted document cannot be trusted; the file is left untouched. */
export class CanvasCorruptError extends Error {
  /** @param reason - what made the document unusable. */
  constructor(readonly reason: string) {
    super(`canvas document is corrupt: ${reason}`)
    this.name = 'CanvasCorruptError'
  }
}

/** Raised when a canvas file was written by a newer format version; the file is left untouched. */
export class CanvasUnsupportedVersionError extends Error {
  /** @param version - the version the file declares. */
  constructor(readonly version: number) {
    super(`canvas document version ${String(version)} is newer than this build understands`)
    this.name = 'CanvasUnsupportedVersionError'
  }
}

/** The canvas of a project that has none yet. */
export const EMPTY_CANVAS: CanvasDocument = { version: 2, revision: 0, nextId: 1, nodes: [], edges: [] }

const NODE_TYPES: readonly CanvasNodeType[] = ['image', 'video', 'audio', 'text', 'script', 'storyboard', 'timeline', 'group']
const EDGE_KINDS: readonly CanvasEdgeKind[] = ['derivation', 'reference']
const EDGE_ROLES: readonly CanvasEdgeRole[] = ['prompt', 'ref', 'first_frame', 'last_frame', 'audio', 'source']
const GENERATION_KINDS: readonly GenerationKind[] = ['image', 'video', 'speech', 'music']
const SHOT_SIZES: readonly ShotSize[] = ['extreme_wide', 'wide', 'full', 'medium', 'medium_close', 'close', 'extreme_close', 'insert']
const STILL_MOTIONS: readonly StillMotion['type'][] = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'static']

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CanvasCorruptError(`${what} is not an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new CanvasCorruptError(`${what} is not a string`)
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  const raw = text(value, what)
  if (!(allowed as readonly string[]).includes(raw)) throw new CanvasCorruptError(`${what} is unknown value ${raw}`)
  return raw as T
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CanvasCorruptError(`${what} is not a finite number`)
  return value
}

/** A positive whole number, such as the next node id suffix. */
function positive(value: unknown, what: string): number {
  const raw = count(value, what)
  if (raw < 1) throw new CanvasCorruptError(`${what} is not a positive integer`)
  return raw
}

function count(value: unknown, what: string): number {
  const raw = finite(value, what)
  if (!Number.isInteger(raw) || raw < 0) throw new CanvasCorruptError(`${what} is not a non-negative integer`)
  return raw
}

function array(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new CanvasCorruptError(`${what} is not an array`)
  return value
}

function params(value: unknown, what: string): Readonly<Record<string, string | number | boolean>> {
  const raw = record(value, what)
  const out: Record<string, string | number | boolean> = {}
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry !== 'string' && typeof entry !== 'boolean' && (typeof entry !== 'number' || !Number.isFinite(entry))) {
      throw new CanvasCorruptError(`${what}.${key} is not a string, number, or boolean`)
    }
    out[key] = entry
  }
  return out
}

function stringList(value: unknown, what: string): readonly string[] {
  return array(value, what).map((entry, index) => text(entry, `${what}[${String(index)}]`))
}

function parseStill(value: unknown, what: string): StillMotion {
  const raw = record(value, what)
  const strength = finite(raw.strength, `${what}.strength`)
  if (strength < 0 || strength > 1) throw new CanvasCorruptError(`${what}.strength is outside 0–1`)
  return { type: oneOf(raw.type, STILL_MOTIONS, `${what}.type`), strength }
}

function parseDialogue(value: unknown, what: string): DialogueLine {
  const raw = record(value, what)
  const speaker = record(raw.speaker, `${what}.speaker`)
  const kind = oneOf(speaker.kind, ['character', 'narrator'] as const, `${what}.speaker.kind`)
  return {
    id: brandString<DialogueId>(text(raw.id, `${what}.id`)),
    speaker: kind === 'narrator'
      ? { kind }
      : { kind, entry: brandString<BibleEntryId>(text(speaker.entry, `${what}.speaker.entry`)) },
    line: text(raw.line, `${what}.line`),
  }
}

function parseShot(value: unknown, what: string): Shot {
  const raw = record(value, what)
  const beat = raw.beat === undefined ? undefined : record(raw.beat, `${what}.beat`)
  return {
    id: brandString<ShotId>(text(raw.id, `${what}.id`)),
    title: text(raw.title, `${what}.title`),
    shotSize: oneOf(raw.shotSize, SHOT_SIZES, `${what}.shotSize`),
    visual: text(raw.visual, `${what}.visual`),
    motion: text(raw.motion, `${what}.motion`),
    camera: text(raw.camera, `${what}.camera`),
    durationSec: finite(raw.durationSec, `${what}.durationSec`),
    characters: stringList(raw.characters, `${what}.characters`).map(entry => brandString<BibleEntryId>(entry)),
    ...raw.scene === undefined ? {} : { scene: brandString<BibleEntryId>(text(raw.scene, `${what}.scene`)) },
    props: stringList(raw.props, `${what}.props`).map(entry => brandString<BibleEntryId>(entry)),
    dialogue: array(raw.dialogue, `${what}.dialogue`).map((entry, index) => parseDialogue(entry, `${what}.dialogue[${String(index)}]`)),
    sfx: text(raw.sfx, `${what}.sfx`),
    negative: text(raw.negative, `${what}.negative`),
    ...raw.still === undefined ? {} : { still: parseStill(raw.still, `${what}.still`) },
    ...beat === undefined ? {} : {
      beat: { fromMs: count(beat.fromMs, `${what}.beat.fromMs`), toMs: count(beat.toMs, `${what}.beat.toMs`) },
    },
  }
}

function parseInput(value: unknown, what: string): NodeInput {
  const raw = record(value, what)
  return {
    node: brandString<CanvasNodeId>(text(raw.node, `${what}.node`)),
    version: brandString<VersionId>(text(raw.version, `${what}.version`)),
    ...raw.role === undefined ? {} : { role: oneOf(raw.role, EDGE_ROLES, `${what}.role`) },
    path: text(raw.path, `${what}.path`),
  }
}

function parseVersion(value: unknown, what: string): NodeVersion {
  const raw = record(value, what)
  const beats = raw.beats === undefined ? undefined : record(raw.beats, `${what}.beats`)
  return {
    id: brandString<VersionId>(text(raw.id, `${what}.id`)),
    ...raw.path === undefined ? {} : { path: text(raw.path, `${what}.path`) },
    ...raw.text === undefined ? {} : { text: text(raw.text, `${what}.text`) },
    ...raw.shots === undefined ? {} : {
      shots: array(raw.shots, `${what}.shots`).map((entry, index) => parseShot(entry, `${what}.shots[${String(index)}]`)),
    },
    ...raw.prompt === undefined ? {} : { prompt: text(raw.prompt, `${what}.prompt`) },
    ...raw.model === undefined ? {} : { model: text(raw.model, `${what}.model`) },
    ...raw.params === undefined ? {} : { params: params(raw.params, `${what}.params`) },
    ...raw.inputs === undefined ? {} : {
      inputs: array(raw.inputs, `${what}.inputs`).map((entry, index) => parseInput(entry, `${what}.inputs[${String(index)}]`)),
    },
    ...raw.durationMs === undefined ? {} : { durationMs: count(raw.durationMs, `${what}.durationMs`) },
    ...raw.width === undefined ? {} : { width: count(raw.width, `${what}.width`) },
    ...raw.height === undefined ? {} : { height: count(raw.height, `${what}.height`) },
    ...beats === undefined ? {} : {
      beats: {
        bpm: finite(beats.bpm, `${what}.beats.bpm`),
        beatsMs: array(beats.beatsMs, `${what}.beats.beatsMs`)
          .map((entry, index) => count(entry, `${what}.beats.beatsMs[${String(index)}]`)),
        sections: array(beats.sections, `${what}.beats.sections`).map((entry, index) => {
          const section = record(entry, `${what}.beats.sections[${String(index)}]`)
          return {
            fromMs: count(section.fromMs, `${what}.beats.sections[${String(index)}].fromMs`),
            toMs: count(section.toMs, `${what}.beats.sections[${String(index)}].toMs`),
          }
        }),
      },
    },
    createdAt: text(raw.createdAt, `${what}.createdAt`),
    origin: oneOf(raw.origin, ['agent', 'user', 'import'] as const, `${what}.origin`),
  }
}

function parseGeneration(value: unknown, what: string): GenerationSpec {
  const raw = record(value, what)
  const shot = raw.shot === undefined ? undefined : record(raw.shot, `${what}.shot`)
  const dialogue = raw.dialogue === undefined ? undefined : record(raw.dialogue, `${what}.dialogue`)
  return {
    kind: oneOf(raw.kind, GENERATION_KINDS, `${what}.kind`),
    prompt: text(raw.prompt, `${what}.prompt`),
    ...raw.model === undefined ? {} : { model: text(raw.model, `${what}.model`) },
    params: raw.params === undefined ? {} : params(raw.params, `${what}.params`),
    ...shot === undefined ? {} : {
      shot: {
        storyboard: brandString<CanvasNodeId>(text(shot.storyboard, `${what}.shot.storyboard`)),
        shots: stringList(shot.shots, `${what}.shot.shots`).map(entry => brandString<ShotId>(entry)),
      },
    },
    ...dialogue === undefined ? {} : {
      dialogue: {
        storyboard: brandString<CanvasNodeId>(text(dialogue.storyboard, `${what}.dialogue.storyboard`)),
        shot: brandString<ShotId>(text(dialogue.shot, `${what}.dialogue.shot`)),
        line: brandString<DialogueId>(text(dialogue.line, `${what}.dialogue.line`)),
      },
    },
    ...raw.tailChain === undefined ? {} : { tailChain: raw.tailChain === true },
  }
}

function parseStatus(value: unknown, what: string): NodeStatus {
  const raw = record(value, what)
  const state = oneOf(raw.state, ['queued', 'running', 'failed'] as const, `${what}.state`)
  if (state === 'failed') {
    if (typeof raw.retryable !== 'boolean') throw new CanvasCorruptError(`${what}.retryable is not a boolean`)
    return { state, at: text(raw.at, `${what}.at`), error: text(raw.error, `${what}.error`), retryable: raw.retryable }
  }
  const jobId = brandString<JobId>(text(raw.jobId, `${what}.jobId`))
  const at = text(raw.at, `${what}.at`)
  if (state === 'queued') return { state, jobId, at }
  return {
    state,
    jobId,
    at,
    ...raw.progress === undefined ? {} : { progress: finite(raw.progress, `${what}.progress`) },
  }
}

function parseExport(value: unknown, what: string): ExportRecord {
  const raw = record(value, what)
  return {
    node: brandString<CanvasNodeId>(text(raw.node, `${what}.node`)),
    preset: text(raw.preset, `${what}.preset`),
    timelineRevision: count(raw.timelineRevision, `${what}.timelineRevision`),
    at: text(raw.at, `${what}.at`),
  }
}

function parseTimeline(value: unknown, what: string): TimelineRef {
  const raw = record(value, what)
  return {
    file: text(raw.file, `${what}.file`),
    durationMs: count(raw.durationMs, `${what}.durationMs`),
    exports: array(raw.exports, `${what}.exports`).map((entry, index) => parseExport(entry, `${what}.exports[${String(index)}]`)),
  }
}

function parseNode(value: unknown, index: number): CanvasNode {
  const raw = record(value, `nodes[${String(index)}]`)
  const id = brandString<CanvasNodeId>(text(raw.id, `nodes[${String(index)}].id`))
  const type = oneOf(raw.type, NODE_TYPES, `node ${id} type`)
  const tailOf = raw.tailOf === undefined ? undefined : record(raw.tailOf, `node ${id} tailOf`)
  return {
    id,
    type,
    title: text(raw.title, `node ${id} title`),
    x: finite(raw.x, `node ${id} x`),
    y: finite(raw.y, `node ${id} y`),
    width: finite(raw.width, `node ${id} width`),
    height: finite(raw.height, `node ${id} height`),
    ...raw.group === undefined ? {} : { group: brandString<CanvasNodeId>(text(raw.group, `node ${id} group`)) },
    ...raw.placed === true ? { placed: true } : {},
    ...raw.versions === undefined ? {} : {
      versions: array(raw.versions, `node ${id} versions`).map((entry, at) => parseVersion(entry, `node ${id} versions[${String(at)}]`)),
    },
    ...raw.activeVersion === undefined ? {} : {
      activeVersion: brandString<VersionId>(text(raw.activeVersion, `node ${id} activeVersion`)),
    },
    ...raw.gen === undefined ? {} : { gen: parseGeneration(raw.gen, `node ${id} gen`) },
    ...raw.status === undefined ? {} : { status: parseStatus(raw.status, `node ${id} status`) },
    ...raw.bible === undefined ? {} : { bible: brandString<BibleEntryId>(text(raw.bible, `node ${id} bible`)) },
    ...raw.timeline === undefined ? {} : { timeline: parseTimeline(raw.timeline, `node ${id} timeline`) },
    ...tailOf === undefined ? {} : {
      tailOf: {
        node: brandString<CanvasNodeId>(text(tailOf.node, `node ${id} tailOf.node`)),
        version: brandString<VersionId>(text(tailOf.version, `node ${id} tailOf.version`)),
      },
    },
    ...raw.stale === true ? { stale: true } : {},
    ...raw.inputChanged === true ? { inputChanged: true } : {},
  }
}

function parseEdge(value: unknown, index: number): CanvasEdge {
  const raw = record(value, `edges[${String(index)}]`)
  const source = brandString<CanvasNodeId>(text(raw.source, `edges[${String(index)}].source`))
  const target = brandString<CanvasNodeId>(text(raw.target, `edges[${String(index)}].target`))
  const kind = oneOf(raw.kind, EDGE_KINDS, `edge ${source}->${target} kind`)
  const role = raw.role === undefined ? undefined : oneOf(raw.role, EDGE_ROLES, `edge ${source}->${target} role`)
  if (kind === 'derivation' && role !== undefined) throw new CanvasCorruptError(`derivation edge ${source}->${target} carries a role`)
  return {
    id: text(raw.id, `edges[${String(index)}].id`),
    source,
    target,
    kind,
    ...role === undefined ? {} : { role },
    ...raw.order === undefined ? {} : { order: count(raw.order, `edge ${source}->${target} order`) },
  }
}

/**
 * Check the invariants every reader relies on.
 * @param document - document to check.
 * @throws {@link CanvasCorruptError} on a duplicate id, a dangling edge or group reference, a nested group, or a
 * malformed edge id.
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
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (source === undefined || target === undefined) throw new CanvasCorruptError(`edge ${edge.id} names a missing node`)
    if (edges.has(edge.id)) throw new CanvasCorruptError(`duplicate edge ${edge.id}`)
    if (edge.id !== edgeId(edge.source, edge.target, edge.role)) {
      throw new CanvasCorruptError(`edge ${edge.id} does not match its endpoints`)
    }
    if (edge.order !== undefined && edge.role !== 'ref' && edge.role !== 'source') {
      throw new CanvasCorruptError(`edge ${edge.id} carries an order without a role that uses one`)
    }
    edges.add(edge.id)
  }
}

/**
 * Migrated node from a version-1 canvas: the old top-level content becomes the first version,
 * stamped with the epoch because a version-1 file records no creation time.
 */
function migrateNode(value: unknown, index: number): CanvasNode {
  const raw = record(value, `nodes[${String(index)}]`)
  const createdAt = '1970-01-01T00:00:00.000Z'
  return parseNode({
    ...raw,
    versions: [{
      id: 'v1',
      ...raw.path === undefined ? {} : { path: raw.path },
      ...raw.text === undefined ? {} : { text: raw.text },
      ...raw.prompt === undefined ? {} : { prompt: raw.prompt },
      ...raw.model === undefined ? {} : { model: raw.model },
      createdAt,
      origin: 'import',
    }],
    activeVersion: 'v1',
  }, index) satisfies CanvasNode
}

/**
 * Migrate a version-1 canvas, naming the role of every reference edge it holds.
 * @param value - parsed JSON of a version-1 file.
 * @returns the document at version 2, revision 0.
 * @throws {@link CanvasCorruptError} when the migrated document breaks an invariant.
 */
export function migrateCanvas(value: unknown): CanvasDocument {
  const raw = record(value, 'document')
  const nodes = array(raw.nodes, 'nodes').map(migrateNode)
  const byId = new Map(nodes.map(node => [node.id, node]))
  const edges = array(raw.edges, 'edges').map((entry, index) => {
    const edge = record(entry, `edges[${String(index)}]`)
    const source = byId.get(brandString<CanvasNodeId>(text(edge.source, `edges[${String(index)}].source`)))
    const target = byId.get(brandString<CanvasNodeId>(text(edge.target, `edges[${String(index)}].target`)))
    if (source === undefined || target === undefined) throw new CanvasCorruptError(`edge ${String(index)} names a missing node`)
    const declared = text(edge.kind, `edges[${String(index)}].kind`)
    if (declared !== 'derivation' && declared !== 'reference') {
      throw new CanvasCorruptError(`edge ${String(index)} has unknown kind ${declared}`)
    }
    const role = declared === 'reference' ? inferRole(source.type, target.type) : undefined
    return {
      id: edgeId(source.id, target.id, role),
      source: source.id,
      target: target.id,
      kind: declared as CanvasEdgeKind,
      ...role === undefined ? {} : { role },
    }
  })
  const document: CanvasDocument = {
    version: 2,
    revision: 0,
    nextId: positive(raw.nextId, 'nextId'),
    nodes,
    edges,
  }
  assertCanvas(document)
  return document
}

/**
 * Reject a document that exceeds the deployment bounds.
 * @param document - validated document.
 * @param limits - resolved deployment bounds.
 * @throws {@link CanvasCorruptError} naming the bound the document exceeds.
 */
export function assertWithinLimits(document: CanvasDocument, limits: ResolvedConfig): void {
  if (document.nodes.length > limits.maxNodes) {
    throw new CanvasCorruptError(`document holds ${String(document.nodes.length)} nodes; the limit is ${String(limits.maxNodes)}`)
  }
  if (document.edges.length > limits.maxEdges) {
    throw new CanvasCorruptError(`document holds ${String(document.edges.length)} edges; the limit is ${String(limits.maxEdges)}`)
  }
  for (const node of document.nodes) {
    if (node.gen !== undefined && node.gen.prompt.length > limits.maxPromptLength) {
      throw new CanvasCorruptError(`node ${node.id} prompt exceeds ${String(limits.maxPromptLength)} characters`)
    }
    for (const version of node.versions ?? []) {
      if (version.prompt !== undefined && version.prompt.length > limits.maxPromptLength) {
        throw new CanvasCorruptError(`node ${node.id} version ${version.id} prompt exceeds ${String(limits.maxPromptLength)} characters`)
      }
      if (version.shots !== undefined && version.shots.length > limits.maxShotsPerStoryboard) {
        throw new CanvasCorruptError(`node ${node.id} storyboard exceeds ${String(limits.maxShotsPerStoryboard)} shots`)
      }
    }
  }
}

/**
 * Parse persisted canvas text.
 * @param source - file content.
 * @param limits - deployment bounds; omitted defaults apply.
 * @returns the validated document, migrated to version 2 when the file is version 1.
 * @throws {@link CanvasUnsupportedVersionError} when the file declares a newer format.
 * @throws {@link CanvasCorruptError} when the text is not a valid canvas.
 */
export function parseCanvas(source: string, limits?: ResolvedConfig): CanvasDocument {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error: unknown) {
    throw new CanvasCorruptError(String(error))
  }
  const raw = record(value, 'document')
  const version = count(raw.version, 'version')
  if (version > 2) throw new CanvasUnsupportedVersionError(version)
  if (version < 1 || version > 2) throw new CanvasCorruptError(`unsupported version ${String(version)}`)
  const document = version === 1 ? migrateCanvas(value) : parseCurrentDocument(value)
  if (limits !== undefined) assertWithinLimits(document, limits)
  return document
}

/** Parse a version-2 document. */
function parseCurrentDocument(value: unknown): CanvasDocument {
  const raw = record(value, 'document')
  const document: CanvasDocument = {
    version: 2,
    revision: count(raw.revision, 'revision'),
    nextId: positive(raw.nextId, 'nextId'),
    nodes: array(raw.nodes, 'nodes').map(parseNode),
    edges: array(raw.edges, 'edges').map(parseEdge),
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

/**
 * Version a node currently shows.
 * @param node - node whose active version is asked for.
 * @returns the active version, the last stored version when no active version is recorded, or undefined when the node has none.
 */
export function activeVersionOf(node: CanvasNode): NodeVersion | undefined {
  if (node.versions === undefined || node.versions.length === 0) return undefined
  const active = node.versions.find(version => version.id === node.activeVersion)
  return active ?? node.versions[node.versions.length - 1]
}
