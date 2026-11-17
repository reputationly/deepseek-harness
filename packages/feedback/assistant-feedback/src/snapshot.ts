/**
 * Build the redacted conversation snapshot a submission attaches.
 *
 * The snapshot exists so an administrator can see what the user was looking at when they
 * reported a problem. It therefore carries the recent turns and the rated reply, never the
 * whole Session, and it is measured after redaction: a snapshot that fits the ceiling with
 * its credentials removed is the one that ships.
 *
 * @module @deepseek-ai/dsh-assistant-feedback/snapshot
 */

import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { redactText } from './redact.ts'
import type { FeedbackSnapshot, SnapshotMessage } from './types.ts'

/** Turns kept when the caller states no bound. */
export const DEFAULT_MAX_TURNS = 20

/** Limits a snapshot obeys. */
export interface SnapshotOptions {
  /** Serialized byte ceiling for the snapshot value. */
  readonly maxBytes: number
  /** Newest turns to keep before applying the byte ceiling. */
  readonly maxTurns?: number
  /** Assistant message the submission rates; its text also ships as the response. */
  readonly targetMessageId?: string
}

/**
 * @param value - value from a derived message.
 * @returns whether the value is a JSON object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read one message's text.
 * @param content - message content from the derived history.
 * @returns the text blocks joined, with non-text blocks named.
 */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (!isRecord(block)) continue
    if (typeof block.text === 'string') { parts.push(block.text); continue }
    if (typeof block.type === 'string') parts.push(`[${block.type}]`)
  }
  return parts.join('\n')
}

/**
 * Derive the turns a snapshot carries.
 * @param events - Session events to read.
 * @returns redacted turns in log order, plus the rated reply when it appears.
 */
function turnsOf(events: readonly SessionEvent[], targetMessageId: string | undefined): { turns: SnapshotMessage[]; response?: string } {
  const turns: SnapshotMessage[] = []
  let response: string | undefined
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    const message = deriveEventMessage(event)
    if (message === null) continue
    const text = redactText(messageText(message.content))
    if (text === '') continue
    const role = typeof message.role === 'string' ? message.role : event.type === 'tool/result' ? 'tool' : 'user'
    turns.push({ role, content: text })
    if (targetMessageId !== undefined && message.id === targetMessageId && event.type === 'assistant/message') {
      response = text
    }
  }
  return response === undefined ? { turns } : { turns, response }
}

/**
 * Measure one snapshot value.
 * @param messages - turns to keep.
 * @param response - rated reply, when any.
 * @returns serialized byte length.
 */
function weightOf(messages: readonly SnapshotMessage[], response: string | undefined): number {
  return Buffer.byteLength(JSON.stringify(response === undefined ? { messages } : { messages, response }), 'utf8')
}

/**
 * Build the snapshot a submission attaches.
 * @param events - Session events of the rated conversation.
 * @param options - byte ceiling, turn bound, and the rated message.
 * @returns the redacted snapshot, flagged when a ceiling dropped turns.
 */
export function buildSnapshot(events: readonly SessionEvent[], options: SnapshotOptions): FeedbackSnapshot {
  const { turns, response } = turnsOf(events, options.targetMessageId)
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const kept = turns.slice(Math.max(0, turns.length - maxTurns))
  let truncated = kept.length < turns.length
  let truncatedReason = truncated ? 'turns' : undefined
  while (kept.length > 1 && weightOf(kept, response) > options.maxBytes) {
    kept.shift()
    truncated = true
    truncatedReason = 'bytes'
  }
  return {
    messages: kept,
    ...response === undefined ? {} : { response },
    truncated,
    ...truncatedReason === undefined ? {} : { truncatedReason },
  }
}
