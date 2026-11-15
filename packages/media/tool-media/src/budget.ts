/**
 * One generation plan: what to create, what to regenerate, and what it costs.
 * @module
 */

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
  readonly gate: GateId | 'media_recovery'
  readonly missing: readonly string[]
}

/** One generation plan: what to create, what to regenerate, and what it costs. */
export interface GenerationPlan {
  /** Nodes that already exist and will be generated again. */
  readonly nodes: readonly PlannedNode[]
  /** Canvas operations that create the nodes the plan needs, applied before generation. */
  readonly create: readonly CanvasOperation[]
  /** Canvas operations that update reused nodes, applied after the plan is confirmed. */
  readonly edits?: readonly CanvasOperation[]
  /** Video nodes whose shots no longer exist in their storyboard. */
  readonly stale: readonly CanvasNodeId[]
  /** Storyboard segments this plan turns into video nodes. */
  readonly segments: readonly { readonly storyboard: CanvasNodeId; readonly index: number; readonly shots: readonly string[] }[]
  readonly blocked?: PlanBlock
  readonly choices?: readonly PlanChoice[]
}
