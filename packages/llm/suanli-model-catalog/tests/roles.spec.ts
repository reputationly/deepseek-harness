/** Model roles: candidates per role, catalog defaults, and choices that survive only while they stay in the catalog. */
import { describe, expect, it } from 'vitest'
import { decodeHiloCatalog } from '../src/hilo.ts'
import { deriveRoles, domainRoleStore, memoryRoleStore } from '../src/roles.ts'
import { hilo } from './hilo-fixture.ts'

function rolesOf(payload: Record<string, unknown>, choices = {}) {
  const decoded = decodeHiloCatalog(payload)
  if (decoded === undefined) throw new Error('fixture catalog does not decode')
  return deriveRoles(decoded.entries, decoded.text, decoded.defaults, choices)
}

describe('deriveRoles', () => {
  it('lists six roles with their candidates and catalog defaults', () => {
    expect(rolesOf(hilo()).map(state => [state.role, state.candidates.map(candidate => candidate.model), state.fallback])).toEqual([
      ['chat', ['deepseek-v4-1-flash', 'qwen3.8-flash-fp8'], 'deepseek-v4-1-flash'],
      ['vision', ['deepseek-v4-1-flash', 'qwen3.8-flash-fp8'], 'qwen3.8-flash-fp8'],
      ['image', ['minimax-h3-image'], 'minimax-h3-image'],
      ['video', ['minimax-h3-2k'], 'minimax-h3-2k'],
      ['music', ['minimax-music3'], 'minimax-music3'],
      ['speech', [], null],
    ])
  })

  it('prefers the enhanced image pipeline as the implicit fallback while keeping an explicit choice', () => {
    const entries = [
      { id: 'generate_image:raw', operation: 'generate_image', model: 'minimax-h3-image', displayName: { zh: '裸模型', en: 'Raw' }, description: { zh: '', en: '' }, transport: { kind: 'images' }, limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 }, default: true },
      { id: 'generate_image:enhanced', operation: 'generate_image', model: 'minimax-h3-image-enhanced', displayName: { zh: '增强', en: 'Enhanced' }, description: { zh: '', en: '' }, transport: { kind: 'images' }, limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 }, default: false },
    ]
    expect(deriveRoles(entries, [], { chat: null, multimodal: null }, {}).find(state => state.role === 'image')?.fallback).toBe('minimax-h3-image-enhanced')
    expect(deriveRoles(entries, [], { chat: null, multimodal: null }, { image: 'minimax-h3-image' }).find(state => state.role === 'image')?.selected).toBe('minimax-h3-image')
  })

  it('keeps only image or video understanding models as vision candidates', () => {
    const vision = rolesOf(hilo({ text: [{ id: 'plain', platformModel: 'plain' }, { id: 'eye', platformModel: 'eye', supportsVideo: true }], defaults: {} }))
      .find(state => state.role === 'vision')
    expect(vision?.candidates.map(candidate => candidate.model)).toEqual(['eye'])
    expect(vision?.fallback).toBe('eye')
  })

  it('applies a choice still in the catalog and drops one that left it', () => {
    const roles = rolesOf(hilo(), { image: 'minimax-h3-image', video: 'gone', chat: 'qwen3.8-flash-fp8' })
    expect(roles.find(state => state.role === 'image')?.selected).toBe('minimax-h3-image')
    expect(roles.find(state => state.role === 'video')?.selected).toBeNull()
    // The conversation's model picker owns the chat choice.
    expect(roles.find(state => state.role === 'chat')?.selected).toBeNull()
  })

  it('falls back to the first candidate when the declared default is not listed', () => {
    const chat = rolesOf(hilo({ defaults: { chat: 'missing' } })).find(state => state.role === 'chat')
    expect(chat?.fallback).toBe('deepseek-v4-1-flash')
  })
})

describe('role stores', () => {
  it('keeps choices and preferences in domain tables', async () => {
    const tables = { choice: new Map<string, { model: string }>(), preference: new Map<string, { enabled: boolean }>() }
    const table = <T>(map: Map<string, T>) => ({
      get: (key: string) => map.get(key),
      put: async (key: string, value: T) => { map.set(key, value) },
    })
    const store = domainRoleStore({ choice: table(tables.choice), preference: table(tables.preference) })
    expect(store.preferences()).toEqual({ autoReview: true })
    await store.choose('image', 'minimax-h3-image')
    await store.setAutoReview(false)
    expect(store.choices()).toEqual({ image: 'minimax-h3-image' })
    expect(store.preferences()).toEqual({ autoReview: false })
    await store.choose('image', null)
    expect(store.choices()).toEqual({})
  })

  it('keeps choices for the process only without a storage domain', async () => {
    const store = memoryRoleStore()
    await store.choose('video', 'minimax-h3-2k')
    expect(store.choices()).toEqual({ video: 'minimax-h3-2k' })
    await store.choose('video', null)
    expect(store.choices()).toEqual({})
  })
})

describe('role edges', () => {
  it('labels a media candidate by its English name or model when the Chinese name is empty', () => {
    const roles = deriveRoles([
      { id: 'generate_image:a', operation: 'generate_image', model: 'a', displayName: { zh: '', en: 'Alpha' }, description: { zh: '', en: '' }, transport: { kind: 'images' }, limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 }, default: true },
      { id: 'generate_image:b', operation: 'generate_image', model: 'b', displayName: { zh: '', en: '' }, description: { zh: '', en: '' }, transport: { kind: 'images' }, limits: { maxReferenceImages: 0, maxDurationSeconds: 0, maxInputBytes: 0 }, default: false },
    ], [], { chat: null, multimodal: null }, {})
    expect(roles.find(state => state.role === 'image')?.candidates).toEqual([{ model: 'a', label: 'Alpha' }, { model: 'b', label: 'b' }])
  })

  it('keeps the review preference for the process only without a storage domain', async () => {
    const store = memoryRoleStore()
    expect(store.preferences()).toEqual({ autoReview: true })
    await store.setAutoReview(false)
    expect(store.preferences()).toEqual({ autoReview: false })
  })
})
