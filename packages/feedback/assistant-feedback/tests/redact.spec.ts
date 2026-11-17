import { describe, expect, it } from 'vitest'
import { isSecretKey, redactText, redactValue } from '../src/redact.ts'

describe('redactText', () => {
  it('masks provider keys, header values, and labelled secrets', () => {
    const text = [
      'export OPENAI_API_KEY=sk-live-9f8a7b6c5d4e3f2a',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9',
      'Cookie: sid=abc123; theme=dark',
      'password: hunter2',
      'api_key = "abc"',
    ].join('\n')
    const redacted = redactText(text)
    for (const secret of ['sk-live-9f8a7b6c5d4e3f2a', 'eyJhbGciOiJIUzI1NiJ9', 'sid=abc123', 'hunter2']) {
      expect(redacted).not.toContain(secret)
    }
    expect(redacted).toContain('OPENAI_API_KEY=sk-***')
    expect(redacted).toContain('Authorization: ***')
  })

  it('leaves ordinary prose untouched', () => {
    const text = 'The build failed because packages/media was removed; rerun pnpm install.'
    expect(redactText(text)).toBe(text)
  })
})

describe('redactValue', () => {
  it('masks values whose property name names a credential and redacts the rest', () => {
    const redacted = redactValue({
      path: '.env',
      content: 'OPENAI_API_KEY=sk-live-abcdef123456',
      apiKey: 'plain-value',
      nested: { Authorization: 'Bearer abcdefghij', note: 'ok' },
      list: ['sk-live-zzzzzzzz'],
    })
    expect(redacted).toEqual({
      path: '.env',
      content: 'OPENAI_API_KEY=sk-***',
      apiKey: '***',
      nested: { Authorization: '***', note: 'ok' },
      list: ['sk-***'],
    })
  })

  it('recognizes the credential property names the site must never receive', () => {
    for (const key of ['apiKey', 'api_key', 'password', 'token', 'cookie', 'client-secret', 'authorization']) {
      expect(isSecretKey(key)).toBe(true)
    }
    expect(isSecretKey('path')).toBe(false)
  })
})
