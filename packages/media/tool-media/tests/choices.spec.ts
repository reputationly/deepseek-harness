/** Parameter settling asks only for values the capability schema cannot settle itself. */
import { expect, it } from 'vitest'
import { settleParams } from '../src/choices.ts'
import type { Capability } from '../src/catalog.ts'

const capability: Capability = {
  id: 'c', operation: 'generate_video', model: 'm',
  paramSchema: { properties: {
    free: { type: 'string' },
    stated: { enum: ['720P', '2K'], title: 'Resolution' },
    invalid: { enum: ['a', 'b'], title: 'Ratio' },
    chosen: { enum: ['x', 'y'], title: 'Speed' },
    defaulted: { enum: ['p', 'q'], default: 'q' },
    skipped: { enum: ['s'] },
  } },
}

it('keeps stated free values and accepted enumerations, and asks for the rest', () => {
  expect(settleParams(capability, {
    requested: { free: '  hello ', stated: '2k', invalid: 'c' },
    ask: ['chosen'],
    skip: ['skipped'],
  })).toEqual({ kind: 'ask', choices: [
    { id: 'invalid', title: 'Ratio', options: ['a', 'b'], recommended: 'a', rejected: 'c' },
    { id: 'chosen', title: 'Speed', options: ['x', 'y'], recommended: 'x' },
  ] })
})

it('returns ready parameters when every value settles', () => {
  expect(settleParams(capability, {
    requested: { free: 'text', stated: '720P', defaulted: 'p' },
    ask: [],
    skip: ['invalid', 'chosen', 'skipped'],
  })).toEqual({ kind: 'ready', params: { free: 'text', stated: '720P', defaulted: 'p' } })
})

it('falls back to the schema default and then the first accepted value', () => {
  expect(settleParams(capability, { requested: {}, ask: [], skip: ['free', 'invalid', 'chosen', 'skipped'] }))
    .toEqual({ kind: 'ready', params: { stated: '720P', defaulted: 'q' } })
})

it('asks for a choosable parameter nobody stated even when a default exists', () => {
  expect(settleParams({ ...capability, paramSchema: { properties: { speed: { enum: ['1', '2'], title: 'Speed', default: '1' } } } }, {
    requested: {}, ask: ['speed'],
  })).toEqual({ kind: 'ask', choices: [{ id: 'speed', title: 'Speed', options: ['1', '2'], recommended: '1' }] })
})

it('uses the parameter id as the title and an empty recommendation when nothing is recommended', () => {
  expect(settleParams({ ...capability, paramSchema: { properties: { mode: { enum: ['a', 'b'] } } } }, {
    requested: { mode: 'z' }, ask: [],
  })).toEqual({ kind: 'ask', choices: [{ id: 'mode', title: 'mode', options: ['a', 'b'], recommended: 'a', rejected: 'z' }] })
})

it('treats a capability without parameters as ready', () => {
  expect(settleParams({ id: 'c', operation: 'op', model: 'm' }, { requested: {}, ask: [] }))
    .toEqual({ kind: 'ready', params: {} })
})

it('asks with the id when a parameter has no title, and skips an unconstrained parameter', () => {
  expect(settleParams({ id: 'c', operation: 'op', model: 'm', paramSchema: { properties: {
    speed: { enum: ['a', 'b'] }, free: { type: 'string' },
  } } }, { requested: {}, ask: ['speed'] })).toEqual({
    kind: 'ask', choices: [{ id: 'speed', title: 'speed', options: ['a', 'b'], recommended: 'a' }],
  })
})
