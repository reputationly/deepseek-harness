/** Host implementation behind the Remote `media` namespace. */
import type { CanvasService } from '@deepseek-ai/dsh-canvas'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { runnerServicesOf, type NodeToolDeps } from './node-tools.ts'
import { budgetOf, type Budget } from './budget.ts'
import { planNodes, type NodePlan } from './node-runner.ts'
import { startPlan } from './runner.ts'
import type { MediaPlanView } from './types.ts'

/** Calls one deployment needs to plan and start media generation. */
export interface MediaRuntimeDeps {
  readonly canvasOf: () => CanvasService
  readonly tools: NodeToolDeps
  readonly jobs: { readonly kill: (id: JobId, caller: Session['id'], reason?: string) => 'requested' | 'already-finished' } | undefined
}

/** View of one budget with no started jobs. */
function viewOfBudget(budget: Budget): MediaPlanView {
  return {
    state: budget.needsConfirmation ? 'needs_confirmation' : 'ready',
    ...budget.needsConfirmation ? { token: budget.token } : {},
    lines: budget.lines.map(line => ({
      node: line.node,
      kind: line.kind,
      model: line.model,
      calls: line.calls,
      ...line.seconds === undefined ? {} : { seconds: line.seconds },
    })),
    totals: budget.totals,
    jobs: [],
  }
}

/** Empty view for a refusal that has no budget. */
function emptyView(state: MediaPlanView['state'], message: string): MediaPlanView {
  return {
    state,
    message,
    lines: [],
    totals: { videoCalls: 0, videoSeconds: 0, imageCalls: 0, speechLines: 0, musicCalls: 0 },
    jobs: [],
  }
}

/** View of a plan's blocked gate. */
function blockedView(plan: NodePlan, deps: MediaRuntimeDeps): MediaPlanView {
  const view = viewOfBudget(budgetOf(plan, deps.tools.confirmLimits))
  const blocked = plan.blocked
  return blocked === undefined
    ? view
    : { ...view, state: 'blocked', message: `${blocked.gate}: ${blocked.missing.join(', ')}` }
}

/**
 * Build the Remote namespace implementation.
 * @param deps - canvas access, tool bounds, and the jobs registry.
 * @returns planning, generation, and cancellation bound to one Session.
 */
export function createMediaRuntime(deps: MediaRuntimeDeps): {
  plan: (session: Session, nodes: readonly string[]) => Promise<MediaPlanView>
  generate: (session: Session, nodes: readonly string[], token: string | undefined) => Promise<MediaPlanView>
  cancel: (session: Session, jobId: string) => boolean
} {
  return {
    plan: async (session, nodes) => {
      const services = await runnerServicesOf(deps.canvasOf, deps.tools, session)
      const loaded = await services.canvas.read()
      const bible = await services.canvas.bible()
      return blockedView(planNodes(loaded.document, bible, nodes.slice(), deps.tools.limits), deps)
    },
    generate: async (session, nodes, token) => {
      const outcome = await startPlan(await runnerServicesOf(deps.canvasOf, deps.tools, session), nodes.slice(), token)
      if (outcome.status === 'blocked') return blockedView(outcome.plan, deps)
      if (outcome.status === 'already_running') return emptyView('already_running', outcome.nodes.join(', '))
      if (outcome.status === 'needs_confirmation') return viewOfBudget(outcome.budget)
      return {
        ...viewOfBudget(budgetOf(outcome.plan, deps.tools.confirmLimits)),
        state: 'started',
        jobs: outcome.jobs.map(job => ({ node: job.node, jobId: job.jobId })),
      }
    },
    cancel: (session, jobId) => deps.jobs?.kill(jobId as JobId, session.id) === 'requested',
  }
}
