/**
 * One Session's feedback surface: the message-feedback object layer and the
 * dialog controller, plus the routing between them. A message target puts a
 * selected judgment through the message controller; the Session target records
 * through the `sessionFeedback` Remote.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client/surface
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FeedbackCategory, FeedbackRecord } from '@deepseek-ai/dsh-command-feedback/types'
import type {} from '@deepseek-ai/dsh-assistant-feedback/remote'
import type { AssistantFeedbackSubmitRequest } from '@deepseek-ai/dsh-assistant-feedback/types'
import { MessageFeedbackController, describe, type MessageFeedbackActionResult } from './controller.ts'
import { FeedbackDialogController } from './dialog.ts'

/**
 * Name the submitted draft members that the feedback site accepts.
 * @param entry - the trimmed text and the category, each present only when given.
 * @returns the present members, without absent keys.
 */
function entryFields(entry: FeedbackRecord): { readonly content?: string; readonly category?: FeedbackCategory } {
  if (entry.text === undefined) return entry.category === undefined ? {} : { category: entry.category }
  return entry.category === undefined ? { content: entry.text } : { content: entry.text, category: entry.category }
}

/** The per-session pair behind every entry of one Session. */
export class FeedbackSurface {
  /** The Session's message-feedback object layer, shared by every message control. */
  readonly feedback: MessageFeedbackController
  /** The Session's dialog and toast state, shared by the overlay entry and the message controls. */
  readonly dialog: FeedbackDialogController

  /**
   * @param ctx - the browser plugin context carrying both feedback Remotes.
   * @param sessionId - Session owning the transcript and the remark.
   */
  constructor(private readonly ctx: ClientContext, private readonly sessionId: SessionId) {
    this.feedback = new MessageFeedbackController(ctx.remote.messageFeedback, sessionId)
    this.dialog = new FeedbackDialogController(async (target, entry) => {
      const result = target.kind === 'message'
        ? await this.feedback.rate(target.messageId, target.rating, entry)
        : await this.recordSession(entry)
      if (result.ok && target.kind === 'message') {
        // The remark is durable locally; the site report must not hold the dialog open.
        void this.report({ channel: 'rating', rating: target.rating === 'positive' ? 'like' : 'dislike', messageId: target.messageId, ...entryFields(entry) })
          .catch(() => undefined)
      } else if (result.ok) {
        const fields = entryFields(entry)
        await this.report(target.kind === 'message'
          // The local verdict vocabulary is positive/negative; the site names like/dislike.
          ? {
            channel: 'rating', rating: target.rating === 'positive' ? 'like' : 'dislike',
            messageId: target.messageId, ...fields,
          }
          : { channel: 'general', ...fields })
      }
      return result
    })
  }

  /** Record one Session-level remark through the sessionFeedback Remote. */
  private async recordSession(entry: FeedbackRecord): Promise<MessageFeedbackActionResult> {
    const carried = await this.ctx.remote.sessionFeedback.record({ sessionId: this.sessionId, ...entry })
    if (!carried.ok) return { ok: false, error: { code: carried.error.code, message: carried.error.message } }
    if (carried.value.ok) return { ok: true }
    return { ok: false, error: { code: carried.value.error.code, message: describe(carried.value.error.code) } }
  }

  /**
   * Report one accepted remark to the deployment's feedback site.
   *
   * The remark is already durable locally, so a failed report never changes the
   * outcome the user sees; it only means the site lacks this submission.
   * @param fields - the verdict or the general text, with the target it names.
   */
  private async report(fields: Omit<AssistantFeedbackSubmitRequest, 'sessionId'>): Promise<void> {
    // A deployment without the relay keeps the local remark and reports nothing.
    const remote = this.ctx.get('remote.assistantFeedback') as ClientContext['remote']['assistantFeedback'] | undefined
    if (remote === undefined) return
    await remote.submit({ sessionId: this.sessionId, ...fields })
  }

  /** Drop both controllers when the owning fiber unloads. */
  dispose(): void {
    this.feedback.dispose()
    this.dialog.dispose()
  }
}
