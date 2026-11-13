/**
 * The budget of one generation plan: what it will call, what it will cost, and the token a caller
 * presents to run it.
 * @module
 */

import { createHash } from 'node:crypto'
import type { CanvasNodeId, CanvasOperation, GenerationKind, GateId } from '@deepseek-ai/dsh-canvas'
import type { ParamChoice } from './choices.ts'

/** One node a plan will generate, and how much of it. */
export interface PlannedNode {
  readonly node: CanvasNodeId
  /** Where the node's content comes from, for a node the plan creates. */
  readonly ref?: string
  readonly kind: GenerationKind
  readonly model: string
  /** Model calls this node needs; a video segment is one call. */
  readonly calls: number
  /** Video seconds this node asks the gateway for. */
  readonly seconds?: number
  /** Lines this node contributes; a speech node voices one per line. */
  readonly lines: number
  /** Titles of the shots this video segment covers. */
  readonly shots?: readonly string[]
}

/** What a plan refuses until the user picks something. */
export interface PlanChoice {
  readonly node: CanvasNodeId
  readonly choices: readonly ParamChoice[]
}

/** What a plan cannot do until an earlier step runs. */
export interface PlanBlock {
  readonly gate: GateId
  readonly missing: readonly string[]
}

/** One generation plan: what to create, what to regenerate, and what it costs. */
export interface GenerationPlan {
  /** Nodes that already exist and will be generated again. */
  readonly nodes: readonly PlannedNode[]
  /** Canvas operations that create the nodes the plan needs, applied before generation. */
  readonly create: readonly CanvasOperation[]
  /** Canvas operations that update reused nodes, applied after the budget is confirmed. */
  readonly edits?: readonly CanvasOperation[]
  /** Video nodes whose shots no longer exist in their storyboard. */
  readonly stale: readonly CanvasNodeId[]
  /** Storyboard segments this plan turns into video nodes. */
  readonly segments: readonly { readonly storyboard: CanvasNodeId; readonly index: number; readonly shots: readonly string[] }[]
  readonly blocked?: PlanBlock
  readonly choices?: readonly PlanChoice[]
}

/** Thresholds above which a plan needs the user's confirmation. */
export interface ConfirmLimits {
  readonly confirmVideoCalls: number
  readonly confirmVideoSeconds: number
  readonly confirmSpeechLines: number
  readonly confirmImageCalls: number
  readonly confirmMusicCalls: number
}

/** Totals a plan is compared against the confirmation thresholds. */
export interface BudgetTotals {
  readonly videoCalls: number
  readonly videoSeconds: number
  readonly imageCalls: number
  readonly speechLines: number
  readonly musicCalls: number
}

/** What a user sees before agreeing to a plan. */
export interface Budget {
  readonly lines: readonly PlannedNode[]
  readonly totals: BudgetTotals
  readonly token: string
  /** Whether running this plan needs the user's confirmation first. */
  readonly needsConfirmation: boolean
}

/** Deterministic JSON so two identical plans always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Token a caller presents to run one plan.
 * @param plan - the plan as it would run.
 * @returns the first 16 hex digits of the plan's SHA-256 digest.
 */
export function confirmToken(plan: GenerationPlan): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex').slice(0, 16)
}

/**
 * Sum one plan.
 * @param nodes - the nodes the plan will generate.
 * @returns the totals.
 */
export function totalsOf(nodes: readonly PlannedNode[]): BudgetTotals {
  const total = (predicate: (node: PlannedNode) => boolean, field: (node: PlannedNode) => number): number =>
    nodes.filter(predicate).reduce((sum, node) => sum + field(node), 0)
  return {
    videoCalls: total(node => node.kind === 'video', node => node.calls),
    videoSeconds: Math.round(total(node => node.kind === 'video', node => node.seconds ?? 0) * 10) / 10,
    imageCalls: total(node => node.kind === 'image', node => node.calls),
    speechLines: total(node => node.kind === 'speech', node => node.lines),
    musicCalls: total(node => node.kind === 'music', node => node.calls),
  }
}

/**
 * Whether one plan crosses a confirmation threshold.
 * @param totals - the plan's totals.
 * @param limits - the deployment's thresholds.
 * @returns whether the user must agree before the plan runs.
 */
export function needsConfirmation(totals: BudgetTotals, limits: ConfirmLimits): boolean {
  return totals.videoCalls >= limits.confirmVideoCalls
    || totals.videoSeconds >= limits.confirmVideoSeconds
    || totals.speechLines >= limits.confirmSpeechLines
    || totals.imageCalls >= limits.confirmImageCalls
    || totals.musicCalls >= limits.confirmMusicCalls
}

/**
 * Build the budget a user confirms.
 * @param plan - the plan to run.
 * @param limits - thresholds that decide whether confirmation is needed.
 * @returns the lines, totals, token, and confirmation flag.
 */
export function budgetOf(plan: GenerationPlan, limits: ConfirmLimits): Budget {
  const lines = plan.nodes
  const totals = totalsOf(lines)
  return { lines, totals, token: confirmToken(plan), needsConfirmation: needsConfirmation(totals, limits) }
}
