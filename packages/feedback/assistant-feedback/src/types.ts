import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Which entry produced a feedback submission. */
export type FeedbackChannel = 'rating' | 'general'

/** Verdict a rating submission carries. */
export type FeedbackRating = 'like' | 'dislike'

/** Surface the submission came from. */
export type FeedbackPlatform = 'web' | 'desktop' | 'ios' | 'android'

/** One submission the Client asks the Host to relay. */
export interface AssistantFeedbackSubmitRequest {
  /** Rating for a message verdict, general for the feedback dialog. */
  readonly channel: FeedbackChannel
  /** Verdict; required for `rating` and dropped for `general`. */
  readonly rating?: FeedbackRating
  /** Category chip the user picked. */
  readonly category?: string
  /** Body the user typed; required for `general`. */
  readonly content?: string
  /** Optional contact the user volunteered. */
  readonly contact?: string
  /** Session the feedback is about. */
  readonly sessionId?: SessionId
  /** Rated assistant message, for `rating`. */
  readonly messageId?: string
  /** Model request that produced the rated reply, when the client captured one. */
  readonly requestId?: string
  /** Model that produced the rated reply. */
  readonly model?: string
  /** Surface the submission came from. */
  readonly platform?: FeedbackPlatform
  /** Device description such as `macOS 15.1; screen=2560x1440`. */
  readonly deviceInfo?: string
  /** Whether to attach the recent-conversation snapshot (default true). */
  readonly attachContext?: boolean
}

/** Why a submission did not reach the feedback site. */
export type AssistantFeedbackFailureCode =
  | 'not-configured' | 'no-key' | 'unauthorized' | 'forbidden'
  | 'rate-limited' | 'too-large' | 'rejected' | 'unreachable'

/** The feedback site accepted the submission. */
export interface AssistantFeedbackSuccess {
  readonly ok: true
  /** Record id the site assigned. */
  readonly id: number
  /** Timestamp the site recorded. */
  readonly createdAt: string
}

/** The submission did not reach the feedback site. */
export interface AssistantFeedbackFailure {
  readonly ok: false
  readonly code: AssistantFeedbackFailureCode
  /** Sentence the surface can show unchanged. */
  readonly message: string
}

/** Outcome of one relayed submission. */
export type AssistantFeedbackSubmitResult = AssistantFeedbackSuccess | AssistantFeedbackFailure

/** One conversation turn inside the attached snapshot. */
export interface SnapshotMessage {
  readonly role: string
  readonly content: string
}

/** Redacted conversation snapshot attached to a submission. */
export interface FeedbackSnapshot {
  /** Recent turns, oldest first. */
  readonly messages: readonly SnapshotMessage[]
  /** Text of the rated reply, when the submission named one. */
  readonly response?: string
  /** Whether turns were dropped to fit the byte ceiling. */
  readonly truncated: boolean
  /** Which ceiling dropped them. */
  readonly truncatedReason?: string
}
