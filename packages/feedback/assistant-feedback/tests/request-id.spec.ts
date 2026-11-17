import { describe, expect, it } from 'vitest'
import { resolveRequestId } from '../src/request-id.ts'

type Event = Parameters<typeof resolveRequestId>[0][number]

/**
 * Build an assistant message event carrying an optional provider request id.
 * @param id - message id.
 * @param requestId - provider id, when the transport read one.
 * @returns the event.
 */
function reply(id: string, requestId?: string): Event {
  return {
    type: 'assistant/message',
    seq: 1,
    time: 0,
    surfaceOp: 'append',
    data: {
      turn: 1, step: 1, stream: [],
      message: { id, role: 'assistant', content: [] },
      ...requestId === undefined ? {} : { providerRequestId: requestId },
    },
  } as unknown as Event
}

describe('resolveRequestId', () => {
  it('reads the id the reply itself carries', () => {
    expect(resolveRequestId([reply('m1', '20261114234000dsh12345678')], 'm1', undefined))
      .toBe('20261114234000dsh12345678')
  })

  it('prefers the id the caller already knows', () => {
    expect(resolveRequestId([reply('m1', 'from-log')], 'm1', 'from-caller')).toBe('from-caller')
  })

  it('returns nothing when the reply predates the field, names another message, or has no target', () => {
    expect(resolveRequestId([reply('m1')], 'm1', undefined)).toBeUndefined()
    expect(resolveRequestId([reply('other', 'id')], 'm1', undefined)).toBeUndefined()
    expect(resolveRequestId([reply('m1', 'id')], undefined, undefined)).toBeUndefined()
    expect(resolveRequestId([], 'm1', '')).toBeUndefined()
  })
})
