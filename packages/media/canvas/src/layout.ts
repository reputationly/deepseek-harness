/**
 * Host-owned placement: new nodes flow left to right from the nodes they connect to, and group
 * frames follow their members.
 * @module
 */

import type { CanvasContentType, CanvasEdge, CanvasNode } from './types.ts'

/** A node while one operation list is being applied. */
export type DraftNode = { -readonly [K in keyof CanvasNode]: CanvasNode[K] }

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const GAP_X = 80
const GAP_Y = 40
const GROUP_PADDING = 30
const GROUP_HEADER = 40

const SIZES: Readonly<Record<CanvasContentType, { readonly width: number; readonly height: number }>> = {
  image: { width: 280, height: 280 },
  video: { width: 320, height: 220 },
  audio: { width: 280, height: 110 },
  text: { width: 280, height: 160 },
  script: { width: 320, height: 260 },
  storyboard: { width: 420, height: 300 },
  timeline: { width: 420, height: 260 },
}

/**
 * Default card size of a content node.
 * @param type - content node kind.
 * @returns width and height in canvas units.
 */
export function nodeSize(type: CanvasContentType): { readonly width: number; readonly height: number } {
  return SIZES[type]
}

function membersOf(nodes: ReadonlyMap<string, DraftNode>, group: string): DraftNode[] {
  return [...nodes.values()].filter(node => node.group === group)
}

function frame(members: readonly Rect[]): Rect {
  const left = Math.min(...members.map(node => node.x))
  const top = Math.min(...members.map(node => node.y))
  const right = Math.max(...members.map(node => node.x + node.width))
  const bottom = Math.max(...members.map(node => node.y + node.height))
  return {
    x: left - GROUP_PADDING,
    y: top - GROUP_PADDING - GROUP_HEADER,
    width: right - left + GROUP_PADDING * 2,
    height: bottom - top + GROUP_PADDING * 2 + GROUP_HEADER,
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * Resize every group frame to its members.
 * @param nodes - working node map, mutated in place.
 */
export function fitGroups(nodes: ReadonlyMap<string, DraftNode>): void {
  for (const group of nodes.values()) {
    if (group.type !== 'group') continue
    const members = membersOf(nodes, group.id)
    if (members.length > 0) Object.assign(group, frame(members))
  }
}

/**
 * Position the content nodes one operation list created. Nodes already on the canvas never move.
 * @param nodes - working node map; created nodes are mutated in place.
 * @param edges - edges after the operation list.
 * @param created - ids of content nodes to place, in creation order.
 */
export function layoutCreated(nodes: ReadonlyMap<string, DraftNode>, edges: readonly CanvasEdge[], created: readonly string[]): void {
  const pending = new Set(created)
  const settled = (id: string): boolean => {
    const node = nodes.get(id)
    if (node === undefined) return false
    return node.type === 'group' ? membersOf(nodes, id).every(member => !pending.has(member.id)) : !pending.has(id)
  }
  const rectOf = (id: string): Rect | undefined => {
    const node = nodes.get(id)
    if (node === undefined) return undefined
    if (node.type !== 'group') return node
    const members = membersOf(nodes, id)
    return members.length === 0 ? node : frame(members)
  }
  const obstacles = (node: DraftNode): Rect[] => {
    const rects: Rect[] = []
    for (const other of nodes.values()) {
      if (other.id === node.id || pending.has(other.id)) continue
      if (other.type !== 'group') {
        rects.push(other)
        continue
      }
      if (other.id === node.group) continue
      const members = membersOf(nodes, other.id).filter(member => !pending.has(member.id))
      if (members.length > 0) rects.push(frame(members))
    }
    return rects
  }
  const settle = (node: DraftNode, x: number, y: number): void => {
    node.x = x
    node.y = y
    const others = obstacles(node)
    for (let hit = others.find(other => overlaps(node, other)); hit !== undefined; hit = others.find(other => overlaps(node, other))) {
      node.y = hit.y + hit.height + GAP_Y
    }
    pending.delete(node.id)
  }

  let flow: Rect | undefined
  const place = (node: DraftNode, force: boolean): boolean => {
    const sources = edges.filter(edge => edge.target === node.id || edge.target === node.group).map(edge => edge.source)
    if (!force && sources.some(source => !settled(source))) return false
    const upstream = sources.map(rectOf).filter((rect): rect is Rect => rect !== undefined && !force)
    if (upstream.length > 0) {
      settle(node, Math.max(...upstream.map(rect => rect.x + rect.width)) + GAP_X, Math.min(...upstream.map(rect => rect.y)))
      return true
    }
    const siblings = node.group === undefined ? [] : membersOf(nodes, node.group).filter(member => !pending.has(member.id))
    if (siblings.length > 0) {
      settle(node, Math.max(...siblings.map(rect => rect.x + rect.width)) + GAP_Y, Math.min(...siblings.map(rect => rect.y)))
      return true
    }
    const downstream = edges.filter(edge => edge.source === node.id && settled(edge.target)).map(edge => rectOf(edge.target))
      .filter((rect): rect is Rect => rect !== undefined)
    if (downstream.length > 0) {
      settle(node, Math.min(...downstream.map(rect => rect.x)) - node.width - GAP_X, Math.min(...downstream.map(rect => rect.y)))
      return true
    }
    if (flow === undefined) {
      const placed = [...nodes.values()].filter(other => !pending.has(other.id) && other.type !== 'group')
      const top = placed.length === 0 ? 0 : Math.max(...placed.map(other => other.y + other.height)) + GAP_Y * 3
      settle(node, placed.length === 0 ? 0 : Math.min(...placed.map(other => other.x)), top)
    } else {
      settle(node, flow.x + flow.width + GAP_Y, flow.y)
    }
    flow = { x: node.x, y: node.y, width: node.width, height: node.height }
    return true
  }

  while (pending.size > 0) {
    let progressed = false
    for (const id of created) {
      const node = nodes.get(id)
      if (node === undefined || !pending.has(id)) continue
      if (place(node, false)) progressed = true
    }
    if (progressed) continue
    for (const stuck of pending) {
      const node = nodes.get(stuck)
      if (node === undefined) {
        pending.delete(stuck)
        continue
      }
      place(node, true)
      break
    }
  }
}
