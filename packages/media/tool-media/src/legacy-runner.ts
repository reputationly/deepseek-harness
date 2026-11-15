/** Legacy tool arguments enter the same durable canvas runner as UI and canvas_generate. */
import { basename, resolve } from 'node:path'
import { activeVersionOf, CanvasConflictError, type CanvasNode, type CanvasOperation } from '@deepseek-ai/dsh-canvas'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { localMediaPath } from './local-path.ts'
import { runnerServicesOf, type NodeToolDeps } from './node-tools.ts'
import { startPlan } from './runner.ts'

/** A preflighted legacy call, before any paid request has been submitted. */
export interface LegacyMediaInput {
  readonly kind: 'image' | 'video' | 'speech' | 'music'
  readonly model: string
  readonly prompt: string
  readonly params: NonNullable<CanvasNode['gen']>['params']
  readonly references?: readonly { readonly path: string; readonly role: 'ref' | 'first_frame' | 'last_frame' }[]
}

/** A tool call that waits for durable generation, or yields to file-only mode without a canvas. */
export type LegacyRunner = (input: LegacyMediaInput, exec: ToolExecution) => Promise<{
  readonly path: string
  readonly model: string
  readonly nodeId: string
} | undefined>

/**
 * The standalone file-only tools still work without a canvas; canvas sessions require the Host jobs registry.
 * @param deps - shared canvas runner dependencies.
 * @param jobs - Host jobs registry used for tool cancellation.
 * @returns a tool adapter that waits for version attachment before reporting success.
 */
export function createLegacyRunner(deps: NodeToolDeps, jobs: {
  kill(id: JobId, caller: NonNullable<ToolExecution['agent']>['session']['id'], reason?: string): unknown
} | undefined): LegacyRunner {
  return async (input, exec) => {
    const canvas = deps.canvas(), session = exec.agent?.session
    if (canvas === undefined || session === undefined) return undefined
    if (jobs === undefined) throw new Error('Canvas media generation requires the jobs service')
    exec.signal.throwIfAborted()
    const target = await canvas.targetOf(session)
    const services = await runnerServicesOf(() => canvas, deps, session, target.episode.id, target.directory)
    const canonical = (path: string): string => resolve(target.directory, localMediaPath(path))
    let nodeId: string | undefined
    for (let attempt = 0; ; attempt++) {
      const { document } = await services.canvas.read()
      const operations: CanvasOperation[] = []
      const sources = new Map<string, string>()
      for (const [index, reference] of (input.references ?? []).entries()) {
        const path = canonical(reference.path)
        if (sources.has(path)) continue
        const existing = document.nodes.find((node) => {
          const recorded = activeVersionOf(node)?.path
          return node.type === 'image' && recorded !== undefined && canonical(recorded) === path
        })
        if (existing !== undefined) sources.set(path, existing.id)
        else {
          const ref = `legacy-source-${index}`
          operations.push({ op: 'add', ref, type: 'image', title: basename(path), path })
          sources.set(path, ref)
        }
      }
      operations.push({
        op: 'add', ref: 'legacy-output', type: input.kind === 'speech' || input.kind === 'music' ? 'audio' : input.kind,
        title: input.prompt.slice(0, 80) || input.kind,
        gen: { kind: input.kind, model: input.model, prompt: input.prompt, params: input.params },
      })
      const connected = new Set<string>()
      for (const reference of input.references ?? []) {
        const source = sources.get(canonical(reference.path))
        if (source === undefined) throw new Error('Reference was not added to the generation plan')
        const key = `${source}:${reference.role}`
        if (connected.has(key)) continue
        connected.add(key)
        operations.push({ op: 'connect', from: source, to: 'legacy-output', kind: 'reference', role: reference.role })
      }
      try {
        const created = await services.canvas.edit(operations, document.revision)
        if (created.skipped.length > 0) throw new Error(`Could not prepare media inputs: ${created.skipped.map(skip => skip.reason).join('; ')}`)
        nodeId = created.refs['legacy-output']
        break
      } catch (error) {
        if (!(error instanceof CanvasConflictError) || attempt >= 4) throw error
      }
    }
    if (nodeId === undefined) throw new Error('Media output node was not created')
    const started = await startPlan(services, [nodeId])
    if (started.status === 'blocked') throw new Error(`${started.plan.blocked?.gate}: ${started.plan.blocked?.missing.join(', ')}`)
    if (started.status === 'already_running') throw new Error(`Media node ${nodeId} already has a running task`)
    const cancel = (): void => { for (const job of started.jobs) jobs.kill(job.jobId, session.id, 'Media tool cancelled') }
    exec.signal.addEventListener('abort', cancel, { once: true })
    if (exec.signal.aborted) cancel()
    try {
      const results = await started.settle
      const result = results.find(result => result.node === nodeId)
      if (result?.ok !== true || result.path === undefined) throw new Error(result?.error ?? `Media node ${nodeId} did not produce a result`)
      return { path: result.path, model: input.model, nodeId }
    } finally {
      exec.signal.removeEventListener('abort', cancel)
    }
  }
}
