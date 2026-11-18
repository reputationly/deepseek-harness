/**
 * Feedback surface plugin, browser half: the Like/Dislike entry in the
 * conversation.chat.assistant-actions strip, the feedback dialog and its
 * acknowledgement and failure toasts in conversation.input.overlay, and the `/feedback`
 * decoration that opens the dialog from the composer menu or a bare typed
 * command. The feedbackUi service opens the same dialog for other plugins.
 * One FeedbackSurface per Session backs every entry in that Session.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the assistant-actions and overlay entries).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the command UI's Context merge (ctx.commandUi).
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { FeedbackDialog } from './FeedbackDialog.tsx'
import { FeedbackDialogController } from './dialog.ts'
import { MessageFeedbackActions } from './MessageFeedbackActions.tsx'
import type { FeedbackDialogInjected, MessageFeedbackInjected } from './slots.ts'
import { FeedbackSurface } from './surface.ts'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'

export type {
  MessageFeedbackActionFailure, MessageFeedbackActionResult, MessageFeedbackStatus,
  MessageFeedbackView,
} from './controller.ts'
export type { FeedbackDialogState, FeedbackDialogTarget, FeedbackSubmit } from './dialog.ts'
export type {
  FeedbackDialogInjected, FeedbackDialogProps, MessageFeedbackActionProps, MessageFeedbackInjected,
} from './slots.ts'
export type { MessageFeedbackKey } from './locales.ts'

/** Opens the feedback form without submitting feedback. */
export interface FeedbackUi {
  /**
   * Open the Session feedback draft without recording feedback.
   * @param sessionId - Session whose feedback draft to open.
   */
  openSession(sessionId: SessionId): void
  /** Open the deployment feedback form, which needs no Session. */
  openGeneral(): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    feedbackUi: FeedbackUi
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'feedback'

/** Client-side deadline for one general submission, above the Host's own request budget. */
const GENERAL_SUBMIT_DEADLINE_MS = 25_000

/** Required services: the slot registry, the two Remote namespaces, and the copy. */
export const inject = ['slots', 'remote', 'remote.messageFeedback', 'remote.sessionFeedback', 'locale']

/**
 * Client plugin body: the per-message feedback entry, the Session's dialog
 * entry, the `feedbackUi` service, the `/feedback` decoration, and their
 * per-session surfaces.
 * @param ctx - client root context.
 */
/** Why a feedback submission cannot run: no deployment gateway row is mounted. */
const RELAY_MISSING = { code: 'unreachable', message: '这台机器没有配置反馈服务' } as const

/**
 * Reach the Host feedback namespace, which only a deployment with a gateway mounts.
 * @param ctx - Client root context.
 * @returns the namespace handle.
 * @throws When this deployment mounts no assistant-feedback row.
 */
function assistantFeedback(ctx: ClientContext): ClientContext['remote']['assistantFeedback'] {
  // The namespace is absent where the deployment mounts no assistant-feedback row.
  const remote = ctx.get('remote.assistantFeedback') as ClientContext['remote']['assistantFeedback'] | undefined
  if (remote === undefined) throw new Error(RELAY_MISSING.message)
  return remote
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-message-feedback: dictionaries')

  // The general dialog belongs to the shell: the More menu lives in the sidebar, which a
  // deployment without an open Session still shows.
  const general = new FeedbackDialogController(async (_target, entry) => {
    // A Host that never answers must not leave the form spinning: the deadline restores the draft.
    const deadline = new Promise<'timeout'>((resolve) => { setTimeout(() => { resolve('timeout') }, GENERAL_SUBMIT_DEADLINE_MS) })
    // The dialog's draft names its body `text`; the site field is `content`.
    const relay = assistantFeedback(ctx)
    const carried = await Promise.race([
      relay.submit({
        channel: 'general',
        ...entry.category === undefined ? {} : { category: entry.category },
        ...entry.text === undefined ? {} : { content: entry.text },
      }),
      deadline,
    ])
    if (carried === 'timeout') return { ok: false, error: { code: 'timeout', message: '反馈提交超时，请稍后重试' } }
    if (!carried.ok) return { ok: false, error: { code: carried.error.code, message: carried.error.message } }
    if (carried.value.ok) return { ok: true }
    return { ok: false, error: { code: carried.value.code, message: carried.value.message } }
  })
  ctx.effect(() => () => { general.dispose() }, 'ui-message-feedback: general dialog')

  const surfaces = new Map<SessionId, FeedbackSurface>()
  const surfaceFor = (sessionId: SessionId): FeedbackSurface => {
    let surface = surfaces.get(sessionId)
    if (surface === undefined) {
      surface = new FeedbackSurface(ctx, sessionId)
      surfaces.set(sessionId, surface)
    }
    return surface
  }
  ctx.effect(() => () => {
    for (const surface of surfaces.values()) surface.dispose()
    surfaces.clear()
  }, 'ui-message-feedback: per-session surfaces')

  const feedbackUi: FeedbackUi = {
    openSession: (sessionId) => { surfaceFor(sessionId).dialog.open({ kind: 'session' }) },
    openGeneral: () => { general.open({ kind: 'general' }) },
  }
  ctx.provide('feedbackUi', feedbackUi)

  // A reconnect can only invalidate what was already read; a cold Session
  // stays cold until something asks for it.
  ctx.on('connection/reset', () => {
    for (const { feedback } of surfaces.values()) {
      if (feedback.getSnapshot().status !== 'cold') void feedback.resync()
    }
  })

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'feedback',
    order: 10,
    locale: NS,
    inject: (sessionId): MessageFeedbackInjected => {
      const { feedback, dialog } = surfaceFor(sessionId)
      return {
        hooks: { feedback },
        ensure: () => feedback.ensure(),
        current: messageId => feedback.getSnapshot().items.get(messageId),
        retract: (messageId, rating) => feedback.retract(messageId, rating),
        openDialog: (messageId, rating) => { dialog.open({ kind: 'message', messageId, rating }) },
      }
    },
  }, MessageFeedbackActions))

  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay',
    id: 'feedback-dialog',
    order: 2,
    locale: NS,
    inject: (sessionId): FeedbackDialogInjected => {
      const { dialog } = surfaceFor(sessionId)
      return {
        hooks: { dialog: dialog.state },
        edit: (draft) => { dialog.edit(draft) },
        submit: () => dialog.submitDraft(),
        dismiss: () => { dialog.dismiss() },
        dismissFailure: () => { dialog.dismissFailure() },
        dismissToast: (seq) => { dialog.dismissToast(seq) },
      }
    },
  }, FeedbackDialog))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'feedback-general',
    locale: NS,
    inject: (): FeedbackDialogInjected => ({
      hooks: { dialog: general.state },
      edit: (draft) => { general.edit(draft) },
      submit: () => general.submitDraft(),
      dismiss: () => { general.dismiss() },
      dismissFailure: () => { general.dismissFailure() },
      dismissToast: (seq) => { general.dismissToast(seq) },
    }),
  }, FeedbackDialog))

  // The Host keeps `/feedback <text>` for a typed remark; a bare invocation
  // from the menu or the composer opens the dialog instead.
  ctx.inject(['commandUi'], (scope: ClientContext) => {
    scope.effect(() => scope.commandUi.decorate({
      name: 'feedback',
      available: () => true,
      ui: { kind: 'action', run: (session) => { feedbackUi.openSession(session.sessionId) } },
    }), 'ui-message-feedback: /feedback decoration')
  })
}
