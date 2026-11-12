/**
 * How a generation run's result reads to the model: the budget it quotes and the sentence it
 * reports.
 * @module
 */

import type { Budget } from './budget.ts'

/** One budget line a user sees before agreeing. */
export interface BudgetLine {
  readonly node: string
  readonly kind: string
  readonly model: string
  readonly calls: number
  readonly seconds: number
  readonly lines: number
}

/** Budget fields a tool result carries. */
export interface BudgetView {
  readonly token: string
  readonly needsConfirmation: boolean
  readonly lines: BudgetLine[]
  readonly totals: Budget['totals']
}

/** One job as the model sees it. */
export interface JobView {
  readonly node: string
  readonly jobId: string
}

/** What a generation tool returns to the model. */
export type GenerationToolResult =
  | { readonly status: 'blocked'; readonly gate: string; readonly missing: string[] }
  | { readonly status: 'needs_confirmation'; readonly budget: BudgetView }
  | { readonly status: 'already_running'; readonly jobs: JobView[] }
  | { readonly status: 'started'; readonly jobs: JobView[] }

/** The optional fields a tool's declared result schema hands the renderer. */
export interface ToolResultView {
  readonly status: string
  readonly gate?: string
  readonly missing?: readonly string[]
  readonly budget?: BudgetView
  readonly jobs?: readonly JobView[]
}

/**
 * Project a budget onto the tool result.
 * @param budget - the plan's budget.
 * @returns the token, totals, and one line per node.
 */
export function budgetView(budget: Budget): BudgetView {
  return {
    token: budget.token,
    needsConfirmation: budget.needsConfirmation,
    lines: budget.lines.map(line => ({
      node: String(line.node),
      kind: line.kind,
      model: line.model,
      calls: line.calls,
      seconds: line.seconds ?? 0,
      lines: line.lines,
    })),
    totals: budget.totals,
  }
}

/**
 * Narrow the schema-typed tool value to the result union the renderer switches on.
 * @param value - value the output schema declares as optional fields.
 * @returns the discriminated result.
 */
export function asResult(value: ToolResultView): GenerationToolResult {
  switch (value.status) {
    case 'blocked':
      return { status: 'blocked', gate: value.gate ?? 'G4_stage_order', missing: [...value.missing ?? []] }
    case 'needs_confirmation':
      if (value.budget === undefined) throw new Error('tool-media: a confirmation result needs its budget')
      return { status: 'needs_confirmation', budget: value.budget }
    case 'already_running':
      return { status: 'already_running', jobs: [...value.jobs ?? []] }
    default:
      return { status: 'started', jobs: [...value.jobs ?? []] }
  }
}

/**
 * Render one run result for the model.
 * @param value - the result.
 * @returns the sentence the model reads.
 */
export function renderResult(value: GenerationToolResult): string {
  switch (value.status) {
    case 'blocked':
      return `Generation blocked (${value.gate}): ${value.missing.join('; ')}`
    case 'already_running':
      return `These nodes already have a generation job: ${value.jobs.map(job => `${job.node} (${job.jobId})`).join(', ')}.`
    case 'needs_confirmation': {
      const totals = value.budget.totals
      const lines = value.budget.lines.map(line => `${line.node} ${line.kind} ${line.model} ×${String(line.calls)}`).join(', ')
      return `This run needs confirmation: ${String(totals.videoCalls)} video calls (${String(totals.videoSeconds)}s), `
        + `${String(totals.imageCalls)} image calls, ${String(totals.speechLines)} spoken lines, ${String(totals.musicCalls)} music calls. `
        + `Lines: ${lines}. Ask the user; call again with confirmToken ${value.budget.token} once they agree.`
    }
    case 'started':
      return `Started ${String(value.jobs.length)} generation job(s): ${value.jobs.map(job => `${job.node} (${job.jobId})`).join(', ')}. `
        + 'A notice arrives when each finishes; read the jobs for progress.'
  }
}
