/** Host implementation behind the Remote `media` namespace. */
import { CanvasInputError, type CanvasService } from '@deepseek-ai/dsh-canvas'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { runnerServicesOf, type NodeToolDeps } from './node-tools.ts'
import type { PlannedNode } from './budget.ts'
import { planNodes, type NodePlan } from './node-runner.ts'
import { startPlan } from './runner.ts'
import type { MediaPlanView } from './types.ts'
import type { MediaRuntime } from './remote.ts'

/** Calls one deployment needs to plan and start media generation. */
export interface MediaRuntimeDeps {
  readonly previewVideo?: (path: string, project: string) => Promise<string>
  readonly canvasOf: () => CanvasService
  readonly tools: NodeToolDeps
  readonly jobs:
    | { readonly kill: (id: JobId, caller: Session['id'], reason?: string) => 'requested' | 'already-finished' }
    | undefined
}

/** Totals one plan's nodes ask for, for the informational plan view. */
function totalsOf(nodes: readonly PlannedNode[]): MediaPlanView['totals'] {
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

/** View of one plan's nodes with no started jobs. */
function viewOfPlan(plan: NodePlan, state: MediaPlanView['state']): MediaPlanView {
  return {
    state,
    lines: plan.nodes.map(line => ({
      node: line.node,
      kind: line.kind,
      model: line.model,
      calls: line.calls,
      ...(line.seconds === undefined ? {} : { seconds: line.seconds }),
    })),
    totals: totalsOf(plan.nodes),
    jobs: [],
  }
}

/** Empty view for a refusal that produced no plan lines. */
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
function blockedView(plan: NodePlan): MediaPlanView {
  const view = viewOfPlan(plan, 'ready')
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
export function createMediaRuntime(deps: MediaRuntimeDeps): MediaRuntime {
  const request = async (run: () => Promise<MediaPlanView>): Promise<MediaPlanView> => {
    try {
      return await run()
    } catch (error: unknown) {
      if (error instanceof CanvasInputError) return emptyView('failed', error.message)
      throw error
    }
  }
  return {
    preview: async (session, id, versionId, scope) => {
      const canvas = deps.canvasOf()
      const target = await canvas.targetOf(session, scope.episode, scope.directory)
      const document = await canvas.read(session, target.episode.id, target.directory)
      const node = document.nodes.find(candidate => candidate.id === id)
      const path = node?.type === 'video' ? node.versions?.find(version => version.id === versionId)?.path : undefined
      if (canvas.directoryOf(session) !== target.directory)
        throw new CanvasInputError('the project changed; reopen the canvas before previewing')
      if (path === undefined)
        throw new CanvasInputError('Video version is unavailable; reread the canvas and choose a retained version')
      if (deps.previewVideo === undefined) throw new Error('Video previews are unavailable')
      return deps.previewVideo(path, target.directory)
    },
    plan: (session, nodes, scope) =>
      request(async () => {
        const services = await runnerServicesOf(deps.canvasOf, deps.tools, session, scope?.episode, scope?.directory)
        const loaded = await services.canvas.read()
        const bible = await services.canvas.bible()
        return blockedView(planNodes(loaded.document, bible, nodes.slice(), deps.tools.limits))
      }),
    generate: (session, nodes, scope) =>
      request(async () => {
        const outcome = await startPlan(
          await runnerServicesOf(deps.canvasOf, deps.tools, session, scope?.episode, scope?.directory),
          nodes.slice(),
        )
        if (outcome.status === 'blocked') return blockedView(outcome.plan)
        if (outcome.status === 'already_running') {
          return { ...emptyView('already_running', outcome.nodes.join(', ')), jobs: outcome.jobs ?? [] }
        }
        return {
          ...viewOfPlan(outcome.plan, 'started'),
          jobs: outcome.jobs.map(job => ({ node: job.node, jobId: job.jobId })),
        }
      }),
    cancel: (session, jobId) => deps.jobs?.kill(jobId as JobId, session.id) === 'requested',
  }
}
