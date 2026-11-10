/**
 * Model-facing canvas tools.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CanvasService } from './index.ts'
import type { CanvasContentType, CanvasDocument, CanvasEditResult, CanvasOperation } from './types.ts'

const TEXT_PREVIEW = 160

/** Canonical `canvas_get` result. */
interface CanvasListing {
  nodes: { id: string; type: string; title: string; group?: string; path?: string; text?: string; prompt?: string }[]
  groups: { id: string; title: string; members: string[] }[]
  edges: { from: string; to: string; kind: string }[]
  missing?: string[]
}

/** Canonical `canvas_edit` result. */
interface CanvasEditOutput {
  created: { id: string; ref?: string }[]
  skipped: { index: number; op: string; reason: string }[]
}

/** One `canvas_edit` operation as the model writes it. */
interface OperationInput {
  op: 'add' | 'update' | 'remove' | 'connect' | 'disconnect' | 'group' | 'ungroup'
  ref?: string
  type?: CanvasContentType
  title?: string
  text?: string
  path?: string
  group?: string
  node?: string
  from?: string
  to?: string
  nodes?: string[]
}

const text = { type: 'string' as const }
const requiredText = { type: 'string' as const, required: true as const }

const listingSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    nodes: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: { id: requiredText, type: requiredText, title: requiredText, group: text, path: text, text, prompt: text },
      },
    },
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
      items: { type: 'object' as const, additionalProperties: false as const, properties: { from: requiredText, to: requiredText, kind: requiredText } },
    },
    missing: { type: 'array' as const, items: text },
  },
}

const editSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
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

/**
 * Project a document to the listing the model reads.
 * @param document - canvas document.
 * @param only - ids to narrow to; a group id also selects its members. Selected nodes carry their full text and prompt.
 * @returns nodes, groups with members, the edges among the listed nodes, and requested ids that do not exist.
 */
export function listCanvas(document: CanvasDocument, only?: readonly string[]): CanvasListing {
  const wanted = only === undefined || only.length === 0 ? undefined : new Set(only)
  const shown = (id: string, group: string | undefined): boolean =>
    wanted === undefined || wanted.has(id) || (group !== undefined && wanted.has(group))
  const nodes = document.nodes.filter(node => node.type !== 'group' && shown(node.id, node.group))
  const groups = document.nodes.filter(node => node.type === 'group' && shown(node.id, undefined))
  const listed = new Set([...nodes, ...groups].map(node => node.id))
  const missing = [...wanted ?? []].filter(id => !document.nodes.some(node => node.id === id))
  const preview = (value: string): string => wanted === undefined && value.length > TEXT_PREVIEW ? `${value.slice(0, TEXT_PREVIEW)}…` : value
  return {
    nodes: nodes.map(node => ({
      id: node.id, type: node.type, title: node.title,
      ...node.group === undefined ? {} : { group: node.group },
      ...node.path === undefined ? {} : { path: node.path },
      ...node.text === undefined ? {} : { text: preview(node.text) },
      ...node.prompt === undefined ? {} : { prompt: preview(node.prompt) },
    })),
    groups: groups.map(group => ({
      id: group.id, title: group.title,
      members: document.nodes.filter(node => node.group === group.id).map(node => node.id),
    })),
    edges: document.edges.filter(edge => wanted === undefined || listed.has(edge.source) || listed.has(edge.target))
      .map(edge => ({ from: edge.source, to: edge.target, kind: edge.kind })),
    ...missing.length === 0 ? {} : { missing },
  }
}

function renderListing(listing: CanvasListing): string {
  if (listing.nodes.length === 0 && listing.groups.length === 0 && listing.missing === undefined) return 'The canvas is empty.'
  const lines: string[] = []
  for (const node of listing.nodes) {
    const detail = [
      node.path === undefined ? undefined : `path=${node.path}`,
      node.group === undefined ? undefined : `group=${node.group}`,
      node.prompt === undefined ? undefined : `prompt=${JSON.stringify(node.prompt)}`,
      node.text === undefined ? undefined : `text=${JSON.stringify(node.text)}`,
    ].filter(part => part !== undefined)
    lines.push(`- ${node.id} ${node.type} ${JSON.stringify(node.title)} ${detail.join(' ')}`.trimEnd())
  }
  for (const group of listing.groups) lines.push(`- ${group.id} group ${JSON.stringify(group.title)} members=${group.members.join(',')}`)
  if (listing.edges.length > 0) lines.push(`Edges: ${listing.edges.map(edge => `${edge.from}->${edge.to}${edge.kind === 'derivation' ? ' (derivation)' : ''}`).join(', ')}`)
  if (listing.missing !== undefined) lines.push(`Not on the canvas: ${listing.missing.join(', ')}`)
  return lines.join('\n')
}

function renderEdit(output: CanvasEditOutput): string {
  const lines: string[] = []
  if (output.created.length > 0) {
    lines.push(`Created ${output.created.map(item => item.ref === undefined ? item.id : `${item.id} (${item.ref})`).join(', ')}.`)
  }
  for (const skip of output.skipped) lines.push(`Skipped operation ${String(skip.index)} (${skip.op}): ${skip.reason}.`)
  return lines.length === 0 ? 'Applied.' : lines.join('\n')
}

function need<T>(value: T | undefined, index: number, input: OperationInput, field: string): T {
  if (value === undefined) throw new Error(`canvas_edit: operations[${String(index)}] (${input.op}) needs ${field}`)
  return value
}

function operationOf(input: OperationInput, index: number): CanvasOperation {
  const optional = {
    ...input.ref === undefined ? {} : { ref: input.ref },
    ...input.title === undefined ? {} : { title: input.title },
  }
  const content = {
    ...input.text === undefined ? {} : { text: input.text },
    ...input.path === undefined ? {} : { path: input.path },
  }
  switch (input.op) {
    case 'add':
      return { op: 'add', type: need(input.type, index, input, 'type'), ...optional, ...content, ...input.group === undefined ? {} : { group: input.group } }
    case 'update':
      return { op: 'update', node: need(input.node, index, input, 'node'), ...input.title === undefined ? {} : { title: input.title }, ...content }
    case 'remove':
      return { op: 'remove', node: need(input.node, index, input, 'node') }
    case 'connect':
      return { op: 'connect', from: need(input.from, index, input, 'from'), to: need(input.to, index, input, 'to') }
    case 'disconnect':
      return { op: 'disconnect', from: need(input.from, index, input, 'from'), to: need(input.to, index, input, 'to') }
    case 'group':
      return { op: 'group', nodes: need(input.nodes, index, input, 'nodes'), ...optional }
    case 'ungroup':
      return { op: 'ungroup', node: need(input.node, index, input, 'node') }
  }
}

function editOutput(result: CanvasEditResult): CanvasEditOutput {
  const refOf = new Map(Object.entries(result.refs).map(([ref, id]) => [id, ref]))
  return {
    created: result.created.map((id) => {
      const ref = refOf.get(id)
      return { id, ...ref === undefined ? {} : { ref } }
    }),
    skipped: result.skipped.map(skip => ({ ...skip })),
  }
}

function sessionOf(tool: string, exec: ToolExecution): Session {
  if (exec.agent === undefined) throw new Error(`${tool} runs only inside a Session`)
  return exec.agent.session
}

/**
 * Register `canvas_get` and `canvas_edit`.
 * @param ctx - context whose tool registry receives the registrations.
 * @param canvas - canvas service the tools read and edit.
 */
export function registerCanvasTools(ctx: Context, canvas: CanvasService): void {
  ctx.tools.register(defineTool({
    name: 'canvas_get',
    description: 'Read the project canvas the user sees beside the conversation: its nodes, groups with their members, and edges.',
    parameters: {
      nodes: { type: 'array', items: { type: 'string' }, description: 'Node or group ids to read in full. Omit to list the whole canvas with long text and prompts shortened.' },
    },
    output: { schema: listingSchema, render: (_args, value) => [{ type: 'text' as const, text: renderListing(value) }] },
    async execute(args, exec) {
      return listCanvas(await canvas.read(sessionOf('canvas_get', exec)), args.nodes)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'canvas_edit',
    description: 'Edit the project canvas with an ordered list of operations applied together. Nodes are positioned automatically. '
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
              enum: ['add', 'update', 'remove', 'connect', 'disconnect', 'group', 'ungroup'],
              description: 'add creates a node from type plus text or path. update changes title, text, or path of node. remove deletes node. '
                + 'connect and disconnect take from and to. group frames nodes under title. ungroup dissolves the group node and keeps its members.',
            },
            ref: { type: 'string', description: 'Name for the node that add or group creates, usable wherever a node id is expected in later operations of this call.' },
            type: { type: 'string', enum: ['image', 'video', 'audio', 'text'] },
            title: { type: 'string', description: 'Short label shown on the node or group.' },
            text: { type: 'string', description: 'Content of a text node.' },
            path: { type: 'string', description: 'File of an image, video, or audio node.' },
            group: { type: 'string', description: 'Existing group that the added node joins.' },
            node: { type: 'string', description: 'Node that update, remove, or ungroup acts on.' },
            from: { type: 'string', description: 'Node or group the edge starts at: the input or source material.' },
            to: { type: 'string', description: 'Node or group the edge points to: what was made from, or depends on, from.' },
            nodes: { type: 'array', items: { type: 'string' }, description: 'Nodes that the new group frames.' },
          },
        },
        description: 'Operations in the order they apply.',
      },
    },
    output: { schema: editSchema, render: (_args, value) => [{ type: 'text' as const, text: renderEdit(value) }] },
    async execute(args, exec) {
      const operations = (args.operations as OperationInput[]).map(operationOf)
      return editOutput(await canvas.edit(sessionOf('canvas_edit', exec), operations))
    },
  }))
}
