/**
 * Model-facing generation tools: one plans and runs a set of canvas nodes, the other voices a
 * storyboard's dialogue.
 * @module
 */

import {
  activeVersionOf, type Bible, type CanvasNode, type CanvasNodeId, type CanvasOperation, type CanvasService,
} from '@deepseek-ai/dsh-canvas'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Budget, ConfirmLimits } from './budget.ts'
import { budgetOf } from './budget.ts'
import type { GeneratedMedia, MediaJob } from './runner.ts'
import { runPlan, type MediaGenerator, type NodeRunResult, type RunnerServices } from './runner.ts'
import type { PlanLimits } from './node-runner.ts'
import { planDialogue } from './voice.ts'

/** Everything the node tools call. */
export interface NodeToolDeps {
  /** Canvas service the Session's project lives in, resolved when a tool runs. */
  readonly canvas: () => CanvasService | undefined
  readonly limits: PlanLimits
  readonly confirmLimits: ConfirmLimits
  readonly concurrency: number
  /** Project spec every generation follows, when known. */
  readonly spec?: { readonly aspect?: string; readonly resolution?: string }
  readonly generate: MediaGenerator
  /** Register one media job for a Session. */
  readonly jobs: (session: Session) => {
    start(spec: { readonly label: string; readonly run: (signal: AbortSignal) => Promise<GeneratedMedia> }): MediaJob
  }
  readonly probe: (path: string) => Promise<{ readonly durationMs?: number; readonly width?: number; readonly height?: number }>
  readonly tailFrame: (path: string) => Promise<string>
}

/** One budget line a user sees before agreeing. */
interface BudgetLine {
  readonly node: string
  readonly kind: string
  readonly model: string
  readonly calls: number
  readonly seconds?: number
  readonly lines?: number
}

/** Budget fields a tool result carries. */
function budgetView(budget: Budget): { token: string; needsConfirmation: boolean; lines: BudgetLine[]; totals: Budget['totals'] } {
  return {
    token: budget.token,
    needsConfirmation: budget.needsConfirmation,
    lines: [...budget.lines].map(line => ({
      node: String(line.node), kind: line.kind, model: line.model, calls: line.calls,
      ...line.seconds === undefined ? {} : { seconds: line.seconds },
      ...line.lines === undefined ? {} : { lines: line.lines },
    })),
    totals: budget.totals,
  }
}

const budgetSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
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
          seconds: { type: 'number' as const },
          lines: { type: 'number' as const },
        },
      },
    },
  },
}

const resultSchema = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    status: { type: 'string' as const, required: true as const, enum: ['done', 'needs_confirmation', 'blocked'] as const },
    gate: { type: 'string' as const },
    missing: { type: 'array' as const, items: { type: 'string' as const } },
    budget: budgetSchema,
    results: {
      type: 'array' as const,
      items: {
        type: 'object' as const, additionalProperties: false as const,
        properties: {
          node: { type: 'string' as const, required: true as const },
          ok: { type: 'boolean' as const, required: true as const },
          jobId: { type: 'string' as const },
          path: { type: 'string' as const },
          error: { type: 'string' as const },
          retryable: { type: 'boolean' as const },
        },
      },
    },
  },
}

/** Render one run result for the model. */
type RunViewResult = Omit<NodeRunResult, 'node'> & { readonly node: string }

/** What a generation tool returns to the model. */
interface GenerationToolResult {
  readonly status: 'done' | 'needs_confirmation' | 'blocked'
  readonly gate?: string
  readonly missing?: string[]
  readonly budget?: ReturnType<typeof budgetView>
  readonly results?: RunViewResult[]
}

function renderRun(value: {
  status: string
  gate?: string
  missing?: readonly string[]
  budget?: { token: string; totals: Record<string, number>; lines: BudgetLine[] }
  results?: readonly RunViewResult[]
}): string {
  if (value.status === 'blocked') return `Generation blocked (${value.gate ?? 'unknown'}): ${(value.missing ?? []).join('; ')}`
  if (value.status === 'needs_confirmation') {
    const totals = value.budget?.totals ?? {}
    const lines = (value.budget?.lines ?? []).map(line => `${line.node} ${line.kind} ${line.model} ×${String(line.calls)}`).join(', ')
    return `This run needs confirmation: ${String(totals.videoCalls ?? 0)} video calls (${String(totals.videoSeconds ?? 0)}s), `
      + `${String(totals.imageCalls ?? 0)} image calls, ${String(totals.speechLines ?? 0)} spoken lines, ${String(totals.musicCalls ?? 0)} music calls. `
      + `Lines: ${lines}. Ask the user; call again with confirmToken ${value.budget?.token ?? ''} once they agree.`
  }
  const done = (value.results ?? []).filter(result => result.ok).length
  const failed = (value.results ?? []).filter(result => !result.ok)
  return `Generated ${String(done)} node(s).`
    + (failed.length === 0 ? '' : ` Failed: ${failed.map(result => `${String(result.node)}: ${result.error ?? 'unknown error'}`).join('; ')}`)
}

/**
 * Register the generation tools.
 * @param ctx - context whose tool registry receives them.
 * @param deps - canvas, generators, jobs, and deployment bounds.
 */
export function registerNodeTools(ctx: import('@deepseek-ai/cordis').Context, deps: NodeToolDeps): void {
  const canvasOf = (): CanvasService => {
    const canvas = deps.canvas()
    if (canvas === undefined) throw new Error('tool-media: the canvas service is not available')
    return canvas
  }
  const servicesOf = async (session: Parameters<CanvasService['read']>[0]): Promise<RunnerServices> => {
    const project = await canvasOf().projectOf(session)
    const spec = deps.spec ?? (project.project === undefined
      ? undefined
      : { aspect: project.project.spec.aspect, resolution: project.project.spec.resolution })
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
      nodeIds: { type: 'array', required: true, items: { type: 'string' }, description: 'Image, video, audio, or storyboard node ids.' },
      confirmToken: { type: 'string', description: 'Token from a previous needs_confirmation result, after the user agreed.' },
    },
    output: { schema: resultSchema, render: (_args, value) => [{ type: 'text' as const, text: renderRun(value) }] },
    async execute(args, exec): Promise<GenerationToolResult> {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('canvas_generate: a Session is required')
      const outcome = await runPlan(await servicesOf(session), args.nodeIds, args.confirmToken)
      if (outcome.status === 'blocked') {
        return {
          status: 'blocked',
          ...outcome.plan.blocked?.gate === undefined ? {} : { gate: outcome.plan.blocked.gate },
          missing: [...outcome.plan.blocked?.missing ?? []],
        }
      }
      if (outcome.status === 'needs_confirmation') {
        return { status: 'needs_confirmation', budget: budgetView(outcome.budget) }
      }
      return { status: 'done', results: outcome.results.map(result => ({ ...result, node: String(result.node) })) }
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
    output: { schema: resultSchema, render: (_args, value) => [{ type: 'text' as const, text: renderRun(value) }] },
    async execute(args, exec): Promise<GenerationToolResult> {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('storyboard_voice: a Session is required')
      const canvas = canvasOf()
      const read = await canvas.read(session)
      const bible: Bible | undefined = (await canvas.bibleOf(session)).bible
      const create: CanvasOperation[] = []
      const planned: { node: CanvasNodeId; kind: 'speech'; model: string; calls: number; lines: number }[] = []
      for (const id of args.storyboards) {
        const board = read.nodes.find(node => node.id === id) as CanvasNode | undefined
        if (board === undefined) throw new Error(`storyboard_voice: node ${id} does not exist`)
        const plan = planDialogue(board, bible, read.nodes, deps.limits.speechModel)
        create.push(...plan.create)
        planned.push(...plan.nodes.map(entry => ({
          node: entry.node, kind: 'speech' as const, model: entry.model, calls: entry.calls, lines: entry.lines ?? 1,
        })))
      }
      const budget = budgetOf({ nodes: planned, create, stale: [], segments: [] }, deps.confirmLimits)
      if (budget.needsConfirmation && budget.token !== args.confirmToken) {
        return { status: 'needs_confirmation', budget: budgetView(budget) }
      }
      const edit = create.length === 0 ? undefined : await canvas.edit(session, create, { baseRevision: read.revision })
      const ids = edit === undefined ? planned.map(entry => entry.node) : Object.values(edit.refs)
      const outcome = await runPlan(await servicesOf(session), ids, undefined, { skipConfirmation: true })
      if (outcome.status !== 'done') return { status: 'blocked', gate: 'G4_stage_order', missing: [] }
      return { status: 'done', results: outcome.results.map(result => ({ ...result, node: String(result.node) })) }
    },
  }))

  void activeVersionOf
}
