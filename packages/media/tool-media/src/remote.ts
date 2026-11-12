/** Remote `media` namespace: the capability catalog and generation planning a Client asks for. */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { capabilitiesFor, type MediaCatalog } from './catalog.ts'
import type { MediaCapabilityView } from './types.ts'

/** Remote service a Client reads media capabilities and plans through. */
export class MediaService extends TypertRemoteService {
  /**
   * @param ctx - owning Context.
   * @param catalog - reads the deployment's capability catalog, when it has one.
   */
  constructor(ctx: Context, private readonly catalog: () => Promise<MediaCatalog | undefined>) {
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
      params: Object.keys(capability.paramSchema?.properties ?? {}),
    }))
  }
}
