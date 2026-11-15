/**
 * How a generation run's result reads to the model.
 * @module
 */

/** One job as the model sees it. */
export interface JobView {
  readonly node: string
  readonly jobId: string
}

/** What a generation tool returns to the model. */
export type GenerationToolResult =
  | { readonly status: 'blocked'; readonly gate: string; readonly missing: string[] }
  | { readonly status: 'already_running'; readonly jobs: JobView[] }
  | { readonly status: 'started'; readonly jobs: JobView[] }

/** The optional fields a tool's declared result schema hands the renderer. */
export interface ToolResultView {
  readonly status: string
  readonly gate?: string
  readonly missing?: readonly string[]
  readonly jobs?: readonly JobView[]
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
    case 'started':
      return `Started ${String(value.jobs.length)} generation job(s): ${value.jobs.map(job => `${job.node} (${job.jobId})`).join(', ')}. `
        + 'A notice arrives when each finishes; read the jobs for progress.'
  }
}
