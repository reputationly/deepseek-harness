import { describe, expect, it } from 'vitest'
import { buildSnapshot } from '../src/snapshot.ts'

type Event = Parameters<typeof buildSnapshot>[0][number]

/**
 * Build a Session event with the minimum fields the surface derivation reads.
 * @param type - event type.
 * @param seq - log position.
 * @param content - message content blocks.
 * @param id - message id, for assistant messages.
 * @returns the event.
 */
function event(type: 'user/message' | 'assistant/message', seq: number, content: unknown, id = `m${String(seq)}`): Event {
  const message = { id, role: type === 'user/message' ? 'user' : 'assistant', content }
  const data = type === 'user/message' ? message : { turn: 1, step: 1, message, stream: [] }
  return { type, seq, time: 0, surfaceOp: 'append', data } as Event
}

describe('buildSnapshot', () => {
  it('keeps the turns, redacts them, and reports the rated reply', () => {
    const snapshot = buildSnapshot([
      event('user/message', 1, [{ type: 'text', text: 'my key is sk-live-abcdef123456' }]),
      event('assistant/message', 2, [{ type: 'text', text: 'stored it' }], 'answer'),
    ], { maxBytes: 60_000, targetMessageId: 'answer' })
    expect(snapshot.messages).toHaveLength(2)
    expect(snapshot.messages[0]?.content).toBe('my key is sk-***')
    expect(snapshot.response).toBe('stored it')
    expect(snapshot.truncated).toBe(false)
  })

  it('drops the oldest turns until the value fits the ceiling', () => {
    const events: Event[] = []
    for (let index = 0; index < 40; index += 1) {
      events.push(event(index % 2 === 0 ? 'user/message' : 'assistant/message', index + 1, [{ type: 'text', text: 'x'.repeat(200) }]))
    }
    const snapshot = buildSnapshot(events, { maxBytes: 800, maxTurns: 40 })
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.truncatedReason).toBe('bytes')
    expect(Buffer.byteLength(JSON.stringify({ messages: snapshot.messages }), 'utf8')).toBeLessThanOrEqual(800)
  })

  it('bounds the turn count before the byte ceiling applies', () => {
    const events: Event[] = Array.from({ length: 10 }, (_, index) =>
      event('user/message', index + 1, [{ type: 'text', text: `turn ${String(index)}` }]))
    const snapshot = buildSnapshot(events, { maxBytes: 60_000, maxTurns: 3 })
    expect(snapshot.messages).toHaveLength(3)
    expect(snapshot.messages.at(-1)?.content).toBe('turn 9')
    expect(snapshot.truncatedReason).toBe('turns')
  })
})
