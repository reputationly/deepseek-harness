/**
 * Model-facing generation tools: one plans and runs a set of canvas nodes, the other voices a
 * storyboard's dialogue.
 * @module
 */

import {
  type Bible, type CanvasNode, type CanvasNodeId, type CanvasOperation, type CanvasService,
} from '@deepseek-ai/dsh-canvas'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConfirmLimits } from './budget.ts'
import { budgetOf } from './budget.ts'
import { asResult, budgetView, renderResult, type GenerationToolResult } from './result-view.ts'
import type { GeneratedMedia, MediaJob } from './runner.ts'
import { startPlan, type MediaGenerator, type RunnerServices } from './runner.ts'
import type { PlanLimits } from './node-runner.ts'
import { planDialogue } from './voice.ts'

/** Everything the node tools call. */
export interface NodeToolDeps {
  /** Canvas service the Session's project lives in, resolved when a tool runs. */
  readonly canvas: () => CanvasService | undefined
  readonly limits: PlanLimits
  readonly confirmLimits: ConfirmLimits
  readonly concurrency: number
  readonly generate: MediaGenerator
  /** Register one media job for a Session. */
  readonly jobs: (session: Session) => {
    start(spec: { readonly label: string; readonly run: (signal: AbortSignal) => Promise<GeneratedMedia> }): MediaJob
  }
  readonly probe: (path: string) => Promise<{ readonly durationMs?: number; readonly width?: number; readonly height?: number }>
  readonly tailFrame: (path: string) => Promise<string>
}

const resultSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    status: { type: 'string' as const, required: true as const, enum: ['started', 'needs_confirmation', 'blocked', 'already_running'] as const },
    gate: { type: 'string' as const },
    missing: { type: 'array' as const, items: { type: 'string' as const } },
    jobs: {
      type: 'array' as const,
      items: {
        type: 'object' as const, additionalProperties: false as const,
        properties: {
          node: { type: 'string' as const, required: true as const },
          jobId: { type: 'string' as const, required: true as const },
        },
      },
    },
    budget: {
      type: 'object' as const, additionalProperties: false as const,
      properties: {
        token: { type: 'string' as const, required: true as const },
        needsConfirmation: { type: 'boolean' as const, required: true as const },
        totals: {
          type: 'object' as const, required: true as const, additionalProperties: false as const,
          properties: {
            videoCalls: { type: 'number' as const, required: true as const },
            videoSeconds: { type: 'number' as const, required: true as const },
            imageCalls: { type: 'number' as const, required: true as const },
            speechLines: { type: 'number' as const, required: true as const },
            musicCalls: { type: 'number' as const, required: true as const },
          },
        },
        lines: {
          type: 'array' as const, required: true as const,
          items: {
            type: 'object' as const, additionalProperties: false as const,
            properties: {
              node: { type: 'string' as const, required: true as const },
              kind: { type: 'string' as const, required: true as const },
              model: { type: 'string' as const, required: true as const },
              calls: { type: 'number' as const, required: true as const },
              seconds: { type: 'number' as const, required: true as const },
              lines: { type: 'number' as const, required: true as const },
            },
          },
        },
      },
    },
  },
}

/**
 * Register the generation tools.
 * @param ctx - context whose tool registry receives them.
 * @param deps - canvas, generators, jobs, and deployment bounds.
 */
export function registerNodeTools(ctx: import('@deepseek-ai/cordis').Context, deps: NodeToolDeps): void {
  const canvasOf = (): CanvasService => {
    const canvas = deps.canvas()
    /* v8 ignore next -- enabling these tools without the canvas row is a composition error, not a caller path */
    if (canvas === undefined) throw new Error('tool-media: the canvas service is not available')
    return canvas
  }
  const servicesOf = async (session: Parameters<CanvasService['read']>[0]): Promise<RunnerServices> => {
    const project = await canvasOf().projectOf(session)
    const spec = project.project === undefined
      ? undefined
      : { aspect: project.project.spec.aspect, resolution: project.project.spec.resolution }
    return {
      ...spec === undefined ? {} : { spec },
      canvas: {
        read: async () => {
          const document = await canvasOf().read(session)
          return { document, revision: document.revision }
        },
        bible: async () => (await canvasOf().bibleOf(session)).bible,
        edit: (operations, baseRevision) => canvasOf().edit(session, operations, { baseRevision }),
      },
      limits: deps.limits,
      confirmLimits: deps.confirmLimits,
      concurrency: deps.concurrency,
      generate: deps.generate,
      jobs: deps.jobs(session),
      probe: deps.probe,
      tailFrame: deps.tailFrame,
      now: () => new Date().toISOString(),
    }
  }
  void ctx

  ctx.tools.register(defineTool({
    name: 'canvas_generate',
    description: 'Generate the media of the given canvas nodes and add a new version to each. One storyboard becomes one '
      + 'video node per segment. A large plan returns needs_confirmation with a token; show the totals to the user and '
      + 'call again with that token once they agree.',
    parameters: {
      nodes: { type: 'array', required: true, items: { type: 'string' }, description: 'Image, video, audio, or storyboard node ids.' },
      confirmToken: { type: 'string', description: 'Token from a previous needs_confirmation result, after the user agreed.' },
    },
    output: { schema: resultSchema, render: (_args, value) => [{ type: 'text' as const, text: renderResult(asResult(value)) }] },
    async execute(args, exec): Promise<GenerationToolResult> {
      const session = exec.agent?.session
      /* v8 ignore next -- every model-facing run has a Session; the guard keeps the SDK face honest */
      if (session === undefined) throw new Error('canvas_generate: a Session is required')
      const outcome = await startPlan(await servicesOf(session), args.nodes, args.confirmToken)
      if (outcome.status === 'blocked') {
        /* v8 ignore next 3 -- a blocked plan always carries its gate */
        return {
          status: 'blocked',
          gate: outcome.plan.blocked?.gate ?? 'G4_stage_order',
          missing: [...outcome.plan.blocked?.missing ?? []],
        }
      }
      if (outcome.status === 'needs_confirmation') {
        return { status: 'needs_confirmation', budget: budgetView(outcome.budget) }
      }
      if (outcome.status === 'already_running') {
        return { status: 'already_running', jobs: outcome.nodes.map(node => ({ node: String(node), jobId: '' })) }
      }
      /* v8 ignore next -- startPlan only yields the four statuses already handled above */
      if (outcome.status !== 'started') throw new Error(`canvas_generate: unexpected outcome ${outcome.status}`)
      return {
        status: 'started',
        jobs: outcome.jobs.map(job => ({ node: String(job.node), jobId: String(job.jobId) })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'storyboard_voice',
    description: 'Create one audio node per spoken line of the given storyboards and synthesize them, reusing nodes that '
      + 'already voice a line. Returns needs_confirmation with a token when the line count crosses the deployment limit.',
    parameters: {
      storyboards: { type: 'array', required: true, items: { type: 'string' }, description: 'Storyboard node ids.' },
      confirmToken: { type: 'string', description: 'Token from a previous needs_confirmation result, after the user agreed.' },
    },
    output: { schema: resultSchema, render: (_args, value) => [{ type: 'text' as const, text: renderResult(asResult(value)) }] },
    async execute(args, exec): Promise<GenerationToolResult> {
      const session = exec.agent?.session
      /* v8 ignore next -- every model-facing run has a Session; the guard keeps the SDK face honest */
      if (session === undefined) throw new Error('storyboard_voice: a Session is required')
      const canvas = canvasOf()
      const read = await canvas.read(session)
      const bible: Bible | undefined = (await canvas.bibleOf(session)).bible
      const create: CanvasOperation[] = []
      const planned: {
        readonly node: CanvasNodeId
        readonly ref?: string
        readonly kind: 'speech'
        readonly model: string
        readonly calls: number
        readonly lines: number
      }[] = []
      for (const id of args.storyboards) {
        const board = read.nodes.find(node => node.id === id) as CanvasNode | undefined
        if (board === undefined) throw new Error(`storyboard_voice: node ${id} does not exist`)
        const plan = planDialogue(board, bible, read.nodes, deps.limits.speechModel)
        create.push(...plan.create)
        planned.push(...plan.nodes.map(entry => ({
          node: entry.node,
          ...entry.ref === undefined ? {} : { ref: entry.ref },
          kind: 'speech' as const,
          model: entry.model,
          calls: entry.calls,
          lines: entry.lines,
        })))
      }
      const budget = budgetOf({ nodes: planned, create, stale: [], segments: [] }, deps.confirmLimits)
      if (budget.needsConfirmation && budget.token !== args.confirmToken) {
        return { status: 'needs_confirmation', budget: budgetView(budget) }
      }
      const edit = create.length === 0 ? undefined : await canvas.edit(session, create, { baseRevision: read.revision })
      // Both the nodes just created and the ones reused by line id generate in this run.
      /* v8 ignore next -- a plan that created a node always names it in refs */
      const ids = planned.map(entry => entry.ref === undefined ? entry.node : edit?.refs[entry.ref] ?? entry.node)
      const outcome = await startPlan(await servicesOf(session), ids, undefined, { skipConfirmation: true })
      /* v8 ignore next -- audio nodes never hit the storyboard or bible gates */
      if (outcome.status === 'blocked') {
        return {
          status: 'blocked',
          gate: outcome.plan.blocked?.gate ?? 'G4_stage_order',
          missing: [...outcome.plan.blocked?.missing ?? []],
        }
      }
      /* v8 ignore next -- this run already confirmed its own budget */
      if (outcome.status === 'needs_confirmation') return { status: 'needs_confirmation', budget: budgetView(outcome.budget) }
      if (outcome.status === 'already_running') return { status: 'already_running', jobs: [] }
      /* v8 ignore next -- startPlan only yields the four statuses already handled above */
      if (outcome.status !== 'started') throw new Error(`storyboard_voice: unexpected outcome ${outcome.status}`)
      return { status: 'started', jobs: outcome.jobs.map(job => ({ node: String(job.node), jobId: String(job.jobId) })) }
    },
  }))

}
