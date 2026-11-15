/** Codec and media failures retain a stable Host-facing category and diagnostic cause. */
import type { TimelineRenderErrorCode } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * A client render failure classified for the Host task journal.
 */
export class TimelineRenderFailure extends Error {
  constructor(readonly code: TimelineRenderErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TimelineRenderFailure'
  }
}
