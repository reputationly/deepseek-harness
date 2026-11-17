/**
 * Resolve the provider request that produced one rated reply.
 *
 * The feedback site searches its request log by this id, so a report must carry the
 * id of the request that produced the reply being rated — never a later one. The
 * reply's own Session event carries it, written by the loop from the transport's
 * finish record; a caller that already knows the id wins, because a resumed or
 * hand-built call may not have gone through this log.
 *
 * @module @deepseek-ai/dsh-assistant-feedback/request-id
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/**
 * @param events - Session events to search.
 * @param messageId - rated assistant message.
 * @param named - id the caller already knows.
 * @returns the provider request id, or undefined when no source has one.
 */
export function resolveRequestId(
  events: readonly SessionEvent[],
  messageId: string | undefined,
  named: string | undefined,
): string | undefined {
  if (named !== undefined && named !== '') return named
  if (messageId === undefined) return undefined
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    if (event.data.message.id !== messageId) continue
    return event.data.providerRequestId === undefined ? undefined : String(event.data.providerRequestId)
  }
  return undefined
}
