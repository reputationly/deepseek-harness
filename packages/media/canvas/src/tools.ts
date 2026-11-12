/**
 * Model-facing canvas tools.
 * @module
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { BibleStyle } from './bible.ts'
import { activeVersionOf } from './document.ts'
import type { CanvasService } from './index.ts'
import { parseScenes } from './storyboard.ts'
import type {
  BibleEntryId, CanvasDocument, CanvasNode, CanvasNodeId, CanvasOperation, DialogueId, EpisodeId, Shot, ShotId,
} from './types.ts'

const TEXT_PREVIEW = 160

/** One row of a canvas listing. */
interface ListedNode {
  id: string
  type: string
  title: string
  group?: string
  version?: string
  versions?: number
  status?: string
  stale?: boolean
  inputChanged?: boolean
  bible?: string
  path?: string
  text?: string
  prompt?: string
  model?: string
  shots?: number
  /** What the node reads, as `role source` pairs. */
  inputs?: string[]
}

/** Canonical `canvas_get` result. */
interface CanvasListing {
  revision: number
  episode: { id: string; title: string }
  hasProject: boolean
  hasBible: boolean
  nodes: ListedNode[]
  groups: { id: string; title: string; members: string[] }[]
  edges: { from: string; to: string; kind: string; role?: string; order?: number }[]
  missing?: string[]
  /** Project metadata or bible JSON, present when the caller asked for it. */
  context?: string
}

/** Canonical `canvas_edit` result. */
interface CanvasEditOutput {
  revision: number
  created: { id: string; ref?: string }[]
  skipped: { index: number; op: string; reason: string }[]
}

/** One `canvas_edit` operation as the model writes it. */
interface OperationInput {
  op: 'add' | 'update' | 'remove' | 'set_gen' | 'set_text' | 'set_shots' | 'update_shot' | 'insert_shot' | 'remove_shot'
    | 'move_shot' | 'set_version' | 'connect' | 'disconnect' | 'reorder_refs' | 'group' | 'ungroup'
  ref?: string
  type?: 'image' | 'video' | 'audio' | 'text' | 'script' | 'storyboard' | 'timeline'
  title?: string
  text?: string
  path?: string
  group?: string
  node?: string
  from?: string
  to?: string
  nodes?: string[]
  bible?: string
  prompt?: string
  model?: string
  genKind?: 'image' | 'video' | 'speech' | 'music'
  params?: Record<string, string | number | boolean | null>
  shots?: ShotInput[]
  shot?: string
  patch?: Record<string, unknown>
  after?: string
  version?: string
  role?: 'prompt' | 'ref' | 'first_frame' | 'last_frame' | 'audio' | 'source'
  order?: number
  sources?: string[]
}

/** One shot as the model writes it. */
interface ShotInput {
  id?: string
  title?: string
  shotSize?: Shot['shotSize']
  visual?: string
  motion?: string
  camera?: string
  durationSec?: number
  characters?: string[]
  scene?: string
  props?: string[]
  dialogue?: { id?: string; speaker?: string; line: string }[]
  sfx?: string
  negative?: string
}

const text = { type: 'string' as const }
const requiredText = { type: 'string' as const, required: true as const }

const nodeRowSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    id: requiredText, type: requiredText, title: requiredText, group: text, version: text,
    versions: { type: 'integer' as const }, status: text, stale: { type: 'boolean' as const },
    inputChanged: { type: 'boolean' as const }, bible: text, path: text, text, prompt: text, model: text,
    shots: { type: 'integer' as const },
    inputs: { type: 'array' as const, items: text },
  },
}

const listingSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    revision: { type: 'integer' as const, required: true as const },
    episode: {
      type: 'object' as const,
      required: true as const,
      additionalProperties: false as const,
      properties: { id: requiredText, title: requiredText },
    },
    hasProject: { type: 'boolean' as const, required: true as const },
    hasBible: { type: 'boolean' as const, required: true as const },
    nodes: { type: 'array' as const, required: true as const, items: nodeRowSchema },
    groups: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { id: requiredText, title: requiredText, members: { type: 'array' as const, required: true as const, items: text } },
      },
    },
    edges: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          from: requiredText, to: requiredText, kind: requiredText, role: text,
          order: { type: 'integer' as const },
        },
      },
    },
    missing: { type: 'array' as const, items: text },
    context: text,
  },
}

const editSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    revision: { type: 'integer' as const, required: true as const },
    created: {
      type: 'array' as const,
      required: true as const,
      items: { type: 'object' as const, additionalProperties: false as const, properties: { id: requiredText, ref: text } },
    },
    skipped: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { index: { type: 'integer' as const, required: true as const }, op: requiredText, reason: requiredText },
      },
    },
  },
}

function preview(value: string, short: boolean): string {
  return short && value.length > TEXT_PREVIEW ? `${value.slice(0, TEXT_PREVIEW)}…` : value
}

function rowOf(node: CanvasNode, document: CanvasDocument, short: boolean): ListedNode {
  const version = activeVersionOf(node)
  const incoming = document.edges.filter(edge => edge.target === node.id)
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    ...node.group === undefined ? {} : { group: node.group },
    ...version === undefined ? {} : { version: version.id },
    ...node.versions === undefined ? {} : { versions: node.versions.length },
    ...node.status === undefined ? {} : { status: node.status.state },
    ...node.stale === true ? { stale: true } : {},
    ...node.inputChanged === true ? { inputChanged: true } : {},
    ...node.bible === undefined ? {} : { bible: node.bible },
    ...version?.path === undefined ? {} : { path: version.path },
    ...version?.text === undefined ? {} : { text: preview(version.text, short) },
    ...version?.prompt === undefined ? {} : { prompt: preview(version.prompt, short) },
    ...version?.model === undefined ? {} : { model: version.model },
    ...version?.shots === undefined ? {} : { shots: version.shots.length },
    ...incoming.length === 0 ? {} : { inputs: incoming.map(edge => `${edge.role ?? edge.kind} ${edge.source}`) },
  }
}

/**
 * Project a document to the listing the model reads.
 * @param document - canvas document.
 * @param context - revisions and files the listing reports beside the nodes.
 * @param only - ids to narrow to; a group id also selects its members.
 * @param detail - `full` keeps long text and returns storyboard shots; `summary` shortens text.
 * @returns rows, groups with members, the edges among the listed nodes, and requested ids that do not exist.
 */
export function listCanvas(
  document: CanvasDocument,
  context: { readonly episode: { id: string; readonly title: string }; readonly hasProject: boolean; readonly hasBible: boolean },
  only?: readonly string[],
  detail: 'summary' | 'full' = 'summary',
): CanvasListing {
  const wanted = only === undefined || only.length === 0 ? undefined : new Set(only)
  const short = detail === 'summary' && wanted === undefined
  const shown = (id: string, group: string | undefined): boolean =>
    wanted === undefined || wanted.has(id) || (group !== undefined && wanted.has(group))
  const nodes = document.nodes.filter(node => node.type !== 'group' && shown(node.id, node.group))
  const groups = document.nodes.filter(node => node.type === 'group' && shown(node.id, undefined))
  const listed = new Set([...nodes, ...groups].map(node => node.id))
  const shotsOf = detail === 'full'
    ? nodes.filter(node => node.type === 'storyboard').map((node) => {
      const shots = activeVersionOf(node)?.shots ?? []
      return `Shots of ${node.id}: ${shots.map(shot => `${shot.id} ${shot.shotSize} ${String(shot.durationSec)}s ${JSON.stringify(shot.visual)}`).join(' | ')}`
    })
    : []
  const missing = [...wanted ?? []].filter(id => !document.nodes.some(node => node.id === id))
  return {
    revision: document.revision,
    episode: { id: context.episode.id, title: context.episode.title },
    hasProject: context.hasProject,
    hasBible: context.hasBible,
    nodes: nodes.map(node => rowOf(node, document, short)),
    groups: groups.map(group => ({
      id: group.id,
      title: group.title,
      members: document.nodes.filter(node => node.group === group.id).map(node => node.id),
    })),
    ...shotsOf.length === 0 ? {} : { context: shotsOf.join('\n') },
    edges: document.edges.filter(edge => wanted === undefined || listed.has(edge.source) || listed.has(edge.target))
      .map(edge => ({
        from: edge.source, to: edge.target, kind: edge.kind,
        ...edge.role === undefined ? {} : { role: edge.role },
        ...edge.order === undefined ? {} : { order: edge.order },
      })),
    ...missing.length === 0 ? {} : { missing },
  }
}

function renderListing(listing: CanvasListing): string {
  const header = `Revision ${String(listing.revision)} · episode ${listing.episode.id} ${JSON.stringify(listing.episode.title)}`
    + `${listing.hasProject ? '' : ' · no project.json'}${listing.hasBible ? '' : ' · no bible.json'}`
  if (listing.nodes.length === 0 && listing.groups.length === 0 && listing.missing === undefined) {
    return [header, 'The canvas is empty.', ...listing.context === undefined ? [] : [listing.context]].join('\n')
  }
  const lines: string[] = [header]
  for (const node of listing.nodes) {
    const detail = [
      node.version === undefined ? undefined : `v=${node.version}`,
      node.versions === undefined || node.versions < 2 ? undefined : `versions=${String(node.versions)}`,
      node.status === undefined ? undefined : `status=${node.status}`,
      node.stale === true ? 'stale' : undefined,
      node.inputChanged === true ? 'input-changed' : undefined,
      node.group === undefined ? undefined : `group=${node.group}`,
      node.bible === undefined ? undefined : `bible=${node.bible}`,
      node.shots === undefined ? undefined : `shots=${String(node.shots)}`,
      node.model === undefined ? undefined : `model=${node.model}`,
      node.path === undefined ? undefined : `path=${node.path}`,
      node.prompt === undefined ? undefined : `prompt=${JSON.stringify(node.prompt)}`,
      node.text === undefined ? undefined : `text=${JSON.stringify(node.text)}`,
      node.inputs === undefined ? undefined : `inputs=${node.inputs.join('+')}`,
    ].filter(part => part !== undefined)
    lines.push(`- ${node.id} ${node.type} ${JSON.stringify(node.title)} ${detail.join(' ')}`.trimEnd())
  }
  for (const group of listing.groups) lines.push(`- ${group.id} group ${JSON.stringify(group.title)} members=${group.members.join(',')}`)
  if (listing.edges.length > 0) {
    lines.push(`Edges: ${listing.edges.map(edge => `${edge.from}->${edge.to}${edge.role === undefined ? '' : `:${edge.role}`}`).join(', ')}`)
  }
  if (listing.missing !== undefined) lines.push(`Not on the canvas: ${listing.missing.join(', ')}`)
  if (listing.context !== undefined) lines.push(listing.context)
  return lines.join('\n')
}

function renderEdit(output: CanvasEditOutput): string {
  const lines: string[] = []
  if (output.created.length > 0) {
    lines.push(`Created ${output.created.map(item => item.ref === undefined ? item.id : `${item.id} (${item.ref})`).join(', ')}.`)
  }
  for (const skip of output.skipped) lines.push(`Skipped operation ${String(skip.index)} (${skip.op}): ${skip.reason}.`)
  const head = `Revision ${String(output.revision)}.`
  return lines.length === 0 ? head : [head, ...lines].join('\n')
}

function need<T>(value: T | undefined, index: number, input: OperationInput, field: string): T {
  if (value === undefined) throw new Error(`canvas_edit: operations[${String(index)}] (${input.op}) needs ${field}`)
  return value
}

function shotOf(input: ShotInput, fallback: number): Shot {
  return {
    id: brandString<ShotId>(input.id ?? `s${String(fallback)}`),
    title: input.title ?? '',
    shotSize: input.shotSize ?? 'medium',
    visual: input.visual ?? '',
    motion: input.motion ?? '',
    camera: input.camera ?? '',
    durationSec: input.durationSec ?? 3,
    characters: (input.characters ?? []).map(entry => brandString<BibleEntryId>(entry)),
    ...input.scene === undefined ? {} : { scene: brandString<BibleEntryId>(input.scene) },
    props: (input.props ?? []).map(entry => brandString<BibleEntryId>(entry)),
    dialogue: (input.dialogue ?? []).map((line, at) => ({
      id: brandString<DialogueId>(line.id ?? `d${String(at + 1)}`),
      speaker: line.speaker === undefined
        ? { kind: 'narrator' as const }
        : { kind: 'character' as const, entry: brandString<BibleEntryId>(line.speaker) },
      line: line.line,
    })),
    sfx: input.sfx ?? '',
    negative: input.negative ?? '',
  }
}

function operationOf(input: OperationInput, index: number): CanvasOperation {
  switch (input.op) {
    case 'add': {
      const shots = input.shots?.map((shot, at) => shotOf(shot, at + 1))
      return {
        op: 'add',
        type: need(input.type, index, input, 'type'),
        ...input.ref === undefined ? {} : { ref: input.ref },
        ...input.title === undefined ? {} : { title: input.title },
        ...input.text === undefined ? {} : { text: input.text },
        ...input.path === undefined ? {} : { path: input.path },
        ...input.group === undefined ? {} : { group: input.group },
        ...input.bible === undefined ? {} : { bible: brandString<BibleEntryId>(input.bible) },
        ...shots === undefined ? {} : { shots },
        ...input.prompt === undefined ? {} : {
          gen: {
            kind: need(input.genKind, index, input, 'genKind'),
            prompt: input.prompt,
            ...input.model === undefined ? {} : { model: input.model },
            params: {},
          },
        },
      }
    }
    case 'update':
      return {
        op: 'update',
        node: need(input.node, index, input, 'node'),
        ...input.title === undefined ? {} : { title: input.title },
        ...input.text === undefined ? {} : { text: input.text },
        ...input.path === undefined ? {} : { path: input.path },
      }
    case 'remove':
      return { op: 'remove', node: need(input.node, index, input, 'node') }
    case 'set_gen':
      return {
        op: 'set_gen',
        node: need(input.node, index, input, 'node'),
        gen: {
          ...input.prompt === undefined ? {} : { prompt: input.prompt },
          ...input.model === undefined ? {} : { model: input.model },
          ...input.genKind === undefined ? {} : { kind: input.genKind },
          ...input.params === undefined ? {} : { params: input.params },
        },
      }
    case 'set_text':
      return { op: 'set_text', node: need(input.node, index, input, 'node'), text: need(input.text, index, input, 'text') }
    case 'set_shots':
      return {
        op: 'set_shots',
        node: need(input.node, index, input, 'node'),
        shots: need(input.shots, index, input, 'shots').map((shot, at) => shotOf(shot, at + 1)),
      }
    case 'update_shot':
      return {
        op: 'update_shot',
        node: need(input.node, index, input, 'node'),
        shot: need(input.shot, index, input, 'shot'),
        patch: input.patch ?? {},
      }
    case 'insert_shot':
      return {
        op: 'insert_shot',
        node: need(input.node, index, input, 'node'),
        shot: shotOf(need(input.shots, index, input, 'shots')[0] ?? {}, 1),
        ...input.after === undefined ? {} : { after: input.after },
      }
    case 'remove_shot':
      return { op: 'remove_shot', node: need(input.node, index, input, 'node'), shot: need(input.shot, index, input, 'shot') }
    case 'move_shot':
      return {
        op: 'move_shot',
        node: need(input.node, index, input, 'node'),
        shot: need(input.shot, index, input, 'shot'),
        ...input.after === undefined ? {} : { after: input.after },
      }
    case 'set_version':
      return { op: 'set_version', node: need(input.node, index, input, 'node'), version: need(input.version, index, input, 'version') }
    case 'connect':
      return {
        op: 'connect',
        from: need(input.from, index, input, 'from'),
        to: need(input.to, index, input, 'to'),
        ...input.role === undefined ? {} : { role: input.role },
        ...input.order === undefined ? {} : { order: input.order },
      }
    case 'disconnect':
      return {
        op: 'disconnect',
        from: need(input.from, index, input, 'from'),
        to: need(input.to, index, input, 'to'),
        ...input.role === undefined ? {} : { role: input.role },
      }
    case 'reorder_refs':
      return {
        op: 'reorder_refs',
        node: need(input.node, index, input, 'node'),
        sources: need(input.sources, index, input, 'sources'),
      }
    case 'group':
      return {
        op: 'group',
        nodes: need(input.nodes, index, input, 'nodes'),
        ...input.ref === undefined ? {} : { ref: input.ref },
        ...input.title === undefined ? {} : { title: input.title },
      }
    case 'ungroup':
      return { op: 'ungroup', node: need(input.node, index, input, 'node') }
  }
}

/** What the service returns for one operation list. */
type EditResult = Parameters<CanvasService['edit']>[0] extends never ? never : {
  readonly revision: number
  readonly created: readonly string[]
  readonly refs: Readonly<Record<string, string>>
  readonly skipped: readonly { index: number; op: string; reason: string }[]
}

function editOutput(result: EditResult): CanvasEditOutput {
  const refOf = new Map(Object.entries(result.refs).map(([ref, id]) => [id, ref]))
  return {
    revision: result.revision,
    created: result.created.map((id) => {
      const ref = refOf.get(id)
      return { id, ...ref === undefined ? {} : { ref } }
    }),
    skipped: result.skipped.map(skip => ({ index: skip.index, op: skip.op, reason: skip.reason })),
  }
}

function sessionOf(tool: string, exec: ToolExecution): Session {
  if (exec.agent === undefined) throw new Error(`${tool} runs only inside a Session`)
  return exec.agent.session
}

/**
 * Register the canvas tools: reading and editing the document, and the studio tools that create
 * projects, episodes, and bible entries.
 * @param ctx - context whose tool registry receives the registrations.
 * @param canvas - canvas service the tools read and edit.
 */
export function registerCanvasTools(ctx: Context, canvas: CanvasService): void {
  ctx.tools.register(defineTool({
    name: 'canvas_get',
    description: 'Read the project canvas the user sees beside the conversation: its nodes, groups with their members, and edges. '
      + 'Nodes report their active version, generation inputs, and whether their storyboard or inputs changed since they were made.',
    parameters: {
      nodes: { type: 'array', items: { type: 'string' }, description: 'Node or group ids to read in full. Omit to list the whole canvas with long text shortened.' },
      detail: {
        type: 'string',
        enum: ['summary', 'full'],
        description: 'summary shortens long text; full keeps it and returns the shots of each storyboard.',
      },
      include: {
        type: 'array',
        items: { type: 'string', enum: ['bible', 'project'] },
        description: 'bible adds the shared style and entries; project adds the production format and episodes.',
      },
    },
    output: { schema: listingSchema, render: (_args, value) => [{ type: 'text' as const, text: renderListing(value) }] },
    async execute(args, exec) {
      const session = sessionOf('canvas_get', exec)
      const document = await canvas.read(session)
      const project = await canvas.projectOf(session)
      const bible = await canvas.bibleOf(session)
      const include = args.include ?? []
      const listing = listCanvas(document, {
        episode: project.current,
        hasProject: project.project !== undefined,
        hasBible: bible.revision > 0,
      }, args.nodes, args.detail ?? 'summary')
      const parts: string[] = []
      if (listing.context !== undefined) parts.push(listing.context)
      if (include.includes('project') && project.project !== undefined) {
        parts.push(`Project: ${JSON.stringify({ project: project.project, revision: project.revision })}`)
      }
      if (include.includes('bible')) parts.push(`Bible: ${JSON.stringify({ bible: bible.bible, revision: bible.revision })}`)
      return parts.length === 0 ? listing : { ...listing, context: parts.join('\n') }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'canvas_edit',
    description: 'Edit the project canvas with an ordered list of operations applied together. Nodes are positioned automatically. '
      + 'baseRevision is the revision canvas_get returned; a stale revision is refused instead of overwriting newer work. '
      + 'An operation that cannot apply is skipped and reported while the others still apply.',
    parameters: {
      operations: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: {
              type: 'string',
              required: true,
              enum: ['add', 'update', 'remove', 'set_gen', 'set_text', 'set_shots', 'update_shot', 'insert_shot', 'remove_shot',
                'move_shot', 'set_version', 'connect', 'disconnect', 'reorder_refs', 'group', 'ungroup'],
              description: 'add creates a node from type plus text, path, shots, or prompt. update changes title, text, or path. '
                + 'set_gen changes how a media node generates and takes params where null deletes a parameter. '
                + 'set_text and set_shots store a new version; update_shot, insert_shot, remove_shot, and move_shot edit one shot. '
                + 'set_version switches the active version. connect and disconnect take from and to, with an optional role. '
                + 'reorder_refs rewrites the reference order. group frames nodes under title; ungroup dissolves the group.',
            },
            ref: { type: 'string', description: 'Name for the node that add or group creates, usable wherever a node id is expected later in this call.' },
            type: { type: 'string', enum: ['image', 'video', 'audio', 'text', 'script', 'storyboard', 'timeline'] },
            title: { type: 'string', description: 'Short label shown on the node or group.' },
            text: { type: 'string', description: 'Content of a text or script node.' },
            path: { type: 'string', description: 'File of an image, video, or audio node.' },
            group: { type: 'string', description: 'Existing group the added node joins.' },
            node: { type: 'string', description: 'Node that the operation acts on.' },
            from: { type: 'string', description: 'Node the edge starts at: the input or source material.' },
            to: { type: 'string', description: 'Node the edge points to: what was made from, or depends on.' },
            nodes: { type: 'array', items: { type: 'string' }, description: 'Nodes that the new group frames.' },
            bible: { type: 'string', description: 'Bible entry this image belongs to.' },
            prompt: { type: 'string', description: 'Prompt of a generated node; may mention bible entries as @name.' },
            model: { type: 'string', description: 'Model id for generation.' },
            genKind: { type: 'string', enum: ['image', 'video', 'speech', 'music'], description: 'What the node generates.' },
            params: { type: 'object', description: 'Generation parameters; null deletes one.', additionalProperties: true, properties: {} },
            shots: { type: 'array', description: 'Shots of a storyboard, or the shot insert_shot adds.', items: { type: 'object', additionalProperties: true, properties: {} } },
            shot: { type: 'string', description: 'Shot id that the operation acts on.' },
            patch: { type: 'object', description: 'Shot fields update_shot replaces.', additionalProperties: true, properties: {} },
            after: { type: 'string', description: 'Shot id the moved or inserted shot follows; omit to append.' },
            version: { type: 'string', description: 'Version id set_version activates.' },
            role: { type: 'string', enum: ['prompt', 'ref', 'first_frame', 'last_frame', 'audio', 'source'], description: 'What the edge supplies. Inferred from node types when omitted.' },
            order: { type: 'integer', description: 'Position among the reference inputs.' },
            sources: { type: 'array', items: { type: 'string' }, description: 'Reference sources in the order reorder_refs applies.' },
          },
        },
        description: 'Operations in the order they apply.',
      },
      baseRevision: { type: 'integer', required: true, description: 'Revision canvas_get returned for the canvas this call edits.' },
    },
    output: { schema: editSchema, render: (_args, value) => [{ type: 'text' as const, text: renderEdit(value) }] },
    async execute(args, exec) {
      const operations = (args.operations as OperationInput[]).map(operationOf)
      return editOutput(await canvas.edit(sessionOf('canvas_edit', exec), operations, { baseRevision: args.baseRevision, origin: 'agent' }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'studio_project_create',
    description: 'Create the project metadata for a production: its format, title, and output specification. '
      + 'The canvas that already exists becomes episode 1 without moving the file.',
    parameters: {
      format: { type: 'string', required: true, enum: ['drama', 'comic', 'mv', 'free'], description: 'Kind of production.' },
      title: { type: 'string', required: true, description: 'Project title shown in the studio header.' },
      aspect: { type: 'string', required: true, enum: ['16:9', '9:16', '1:1', '4:3', '3:4'], description: 'Frame aspect of every episode.' },
      resolution: { type: 'string', required: true, description: 'Output resolution, such as 1080p.' },
      fps: { type: 'number', required: true, enum: [24, 25, 30], description: 'Frames per second of the final cut.' },
    },
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          revision: { type: 'integer' as const, required: true as const },
          format: requiredText,
          title: requiredText,
          episodes: { type: 'integer' as const, required: true as const },
        },
      },
      render: (_args, value: { revision: number; format: string; title: string; episodes: number }) => [{
        type: 'text' as const,
        text: `Project ${JSON.stringify(value.title)} (${value.format}) created with ${String(value.episodes)} episode(s) at revision ${String(value.revision)}.`,
      }],
    },
    async execute(args, exec) {
      const created = await canvas.createProject(sessionOf('studio_project_create', exec), {
        format: args.format,
        title: args.title,
        spec: { aspect: args.aspect, resolution: args.resolution, fps: args.fps },
      })
      return {
        revision: created.revision,
        format: created.project.format,
        title: created.project.title,
        episodes: created.project.episodes.length,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'studio_episode_create',
    description: 'Add an episode to the project and write it to its own canvas file.',
    parameters: { title: { type: 'string', required: true, description: 'Episode title.' } },
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          revision: { type: 'integer' as const, required: true as const },
          episode: { type: 'object' as const, required: true as const, additionalProperties: false as const, properties: { id: requiredText, title: requiredText } },
        },
      },
      render: (_args, value: { revision: number; episode: { id: string; title: string } }) => [{
        type: 'text' as const,
        text: `Episode ${value.episode.id} ${JSON.stringify(value.episode.title)} created at revision ${String(value.revision)}.`,
      }],
    },
    async execute(args, exec) {
      return canvas.createEpisode(sessionOf('studio_episode_create', exec), args.title)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'studio_episode_use',
    description: 'Switch which episode this conversation edits. Later canvas calls act on that episode.',
    parameters: { episode: { type: 'string', required: true, description: 'Episode id from canvas_get or studio_episode_create.' } },
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { revision: { type: 'integer' as const, required: true as const } },
      },
      render: (_args, value: { revision: number }) => [{ type: 'text' as const, text: `This conversation now edits that episode (revision ${String(value.revision)}).` }],
    },
    async execute(args, exec) {
      return canvas.useEpisode(sessionOf('studio_episode_use', exec), brandString<EpisodeId>(args.episode))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'studio_bible_update',
    description: 'Update the shared bible: the logline, the visual style, and the characters, locations, and props every episode draws on. '
      + 'Entries are matched by id; removing an entry a storyboard still uses is refused.',
    parameters: {
      logline: { type: 'string', description: 'One-sentence premise of the production.' },
      style: {
        type: 'object',
        description: 'Style fields to replace.',
        additionalProperties: false,
        properties: {
          visual: text,
          palette: text,
          aspect: { type: 'string' as const, enum: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
          director: text,
          genre: text,
          tone: text,
        },
      },
      upsert: {
        type: 'array',
        description: 'Full entries to add or replace. An entry with an existing id replaces it.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: requiredText,
            kind: { type: 'string', required: true, enum: ['character', 'location', 'prop'] },
            name: requiredText,
            aliases: { type: 'array', items: text },
            description: { type: 'string', required: true },
            imageNodes: { type: 'array', items: text },
            voice: {
              type: 'object',
              additionalProperties: false,
              properties: { model: text, voice: text, sampleNode: text },
            },
          },
        },
      },
      remove: { type: 'array', items: { type: 'string' }, description: 'Entry ids to delete.' },
      baseRevision: { type: 'integer', description: 'Bible revision the caller read; a stale one is refused.' },
    },
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          revision: { type: 'integer' as const, required: true as const },
          entries: { type: 'integer' as const, required: true as const },
          names: { type: 'array' as const, required: true as const, items: text },
        },
      },
      render: (_args, value: { revision: number; entries: number; names: readonly string[] }) => [{
        type: 'text' as const,
        text: `Bible saved at revision ${String(value.revision)} with ${String(value.entries)} entries: ${value.names.join(', ')}.`,
      }],
    },
    async execute(args, exec) {
      const request: Parameters<CanvasService['updateBible']>[1] = {
        ...args.logline === undefined ? {} : { logline: args.logline },
        ...args.style === undefined ? {} : { style: args.style as BibleStyle },
        ...args.upsert === undefined ? {} : {
          upsert: args.upsert.map(entry => ({
            id: brandString<BibleEntryId>(entry.id),
            kind: entry.kind,
            name: entry.name,
            aliases: entry.aliases ?? [],
            description: entry.description,
            imageNodes: (entry.imageNodes ?? []).map(node => brandString<CanvasNodeId>(node)),
            ...entry.voice === undefined ? {} : {
              voice: {
                ...entry.voice.model === undefined ? {} : { model: entry.voice.model },
                ...entry.voice.voice === undefined ? {} : { voice: entry.voice.voice },
                ...entry.voice.sampleNode === undefined ? {} : { sampleNode: brandString<CanvasNodeId>(entry.voice.sampleNode) },
              },
            },
          })),
        },
        ...args.remove === undefined ? {} : { remove: args.remove.map(entry => brandString<BibleEntryId>(entry)) },
      }
      const updated = await canvas.updateBible(sessionOf('studio_bible_update', exec), request, args.baseRevision)
      return {
        revision: updated.revision,
        entries: updated.bible.entries.length,
        names: updated.bible.entries.map(entry => `${entry.id} ${entry.name}`),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'studio_expand_script',
    description: 'Lay a script out on the canvas: one group per scene, holding a text node with the scene body and an empty storyboard '
      + 'that reads it as its prompt. Scenes already laid out are skipped.',
    parameters: {
      script: { type: 'string', required: true, description: 'Script node id whose active version holds the scenes.' },
      scenes: { type: 'array', items: { type: 'integer' }, description: 'Scene numbers to lay out; omit for every scene.' },
      baseRevision: { type: 'integer', required: true, description: 'Canvas revision the caller read.' },
    },
    output: { schema: editSchema, render: (_args, value) => [{ type: 'text' as const, text: renderEdit(value) }] },
    async execute(args, exec) {
      const session = sessionOf('studio_expand_script', exec)
      const document = await canvas.read(session)
      const script = document.nodes.find(node => node.id === args.script)
      if (script === undefined) throw new Error(`canvas: node ${args.script} does not exist`)
      if (script.type !== 'script' && script.type !== 'text') throw new Error(`canvas: node ${args.script} holds no script text`)
      const body = activeVersionOf(script)?.text ?? ''
      const wanted = args.scenes === undefined ? undefined : new Set(args.scenes)
      const groups = new Set(document.nodes.filter(node => node.type === 'group').map(node => node.title))
      const operations: CanvasOperation[] = []
      for (const scene of parseScenes(body)) {
        if (scene.title === '' && scene.body === '') continue
        if (wanted !== undefined && !wanted.has(scene.number)) continue
        const title = `场${String(scene.number)}${scene.title === '' ? '' : ` ${scene.title}`}`
        if (groups.has(title)) continue
        operations.push(
          { op: 'add', ref: `text${String(scene.number)}`, type: 'text', title, text: scene.body },
          { op: 'add', ref: `board${String(scene.number)}`, type: 'storyboard', title: `${title} 分镜`, shots: [] },
          { op: 'group', ref: `group${String(scene.number)}`, title, nodes: [`text${String(scene.number)}`, `board${String(scene.number)}`] },
          { op: 'connect', from: `text${String(scene.number)}`, to: `board${String(scene.number)}`, role: 'prompt' },
        )
      }
      if (operations.length === 0) {
        return { revision: document.revision, created: [], skipped: [] }
      }
      return editOutput(await canvas.edit(session, operations, { baseRevision: args.baseRevision, origin: 'agent' }))
    },
  }))
}
