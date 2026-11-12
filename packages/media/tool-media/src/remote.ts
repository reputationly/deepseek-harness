/** Remote `media` namespace: the capability catalog and generation a Client drives. */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { capabilitiesFor, type MediaCatalog } from './catalog.ts'
import type { MediaCapabilityView, MediaPlanView } from './types.ts'

/** Host calls the Remote namespace delegates to. */
export interface MediaRuntime {
  /** Plan the nodes without changing the canvas or starting work. */
  readonly plan: (session: Session, nodes: readonly string[]) => Promise<MediaPlanView>
  /** Start the plan, presenting the confirmation token when the user agreed to the totals. */
  readonly generate: (session: Session, nodes: readonly string[], token: string | undefined) => Promise<MediaPlanView>
  /** Cancel one running media job the Session owns. */
  readonly cancel: (session: Session, jobId: string) => boolean
}

/** Remote service a Client reads media capabilities and plans generations through. */
export class MediaService extends TypertRemoteService {
  /**
   * @param ctx - owning Context.
   * @param catalog - reads the deployment's capability catalog, when it has one.
   * @param runtime - plans and starts generation for one Session.
   */
  constructor(
    ctx: Context,
    private readonly catalog: () => Promise<MediaCatalog | undefined>,
    private readonly runtime: MediaRuntime,
  ) {
    super(ctx, 'media')
  }

  /**
   * List the models one gateway operation offers.
   * @param session - Session whose deployment calls the gateway.
   * @param operation - gateway operation such as `generate_video`.
   * @returns one entry per model.
   */
  @Remote('capabilities')
  async capabilities(session: Session, operation: string): Promise<MediaCapabilityView[]> {
    void session
    const catalog = await this.catalog()
    if (catalog === undefined) return []
    return capabilitiesFor(catalog, operation).map(capability => ({
      id: capability.id,
      model: capability.model,
      operation: capability.operation,
      params: Object.entries(capability.paramSchema?.properties ?? {}).map(([id, param]) => ({
        id,
        ...param.title === undefined ? {} : { title: param.title },
        ...param.enum === undefined ? {} : { options: [...param.enum] },
        ...param.default === undefined ? {} : { default: param.default },
        ...param.type === undefined ? {} : { type: param.type },
      })),
    }))
  }

  /**
   * Plan the given nodes and their budget without starting work.
   * @param session - Session that owns the canvas.
   * @param nodes - canvas node ids to generate.
   * @returns the plan, its totals, and a confirmation token when the user must agree first.
   */
  @Remote('planNodes')
  planNodes(session: Session, nodes: readonly string[]): Promise<MediaPlanView> {
    return this.runtime.plan(session, nodes)
  }

  /**
   * Start the given nodes' generation.
   * @param session - Session that owns the canvas.
   * @param nodes - canvas node ids to generate.
   * @param token - confirmation token from `planNodes`, after the user agreed.
   * @returns the started jobs, or why nothing started.
   */
  @Remote('generateNodes')
  generateNodes(session: Session, nodes: readonly string[], token: string | undefined): Promise<MediaPlanView> {
    return this.runtime.generate(session, nodes, token)
  }

  /**
   * Cancel one running media job.
   * @param session - Session that owns the job.
   * @param jobId - job id a plan reported.
   * @returns whether the Host accepted the cancellation.
   */
  @Remote('cancelMediaJob')
  cancelMediaJob(session: Session, jobId: string): boolean {
    return this.runtime.cancel(session, jobId)
  }
}
