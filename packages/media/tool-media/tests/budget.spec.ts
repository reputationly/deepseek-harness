import { describe, expect, it } from 'vitest'
import { budgetOf, canonicalJson, confirmToken, needsConfirmation, totalsOf, type GenerationPlan, type PlannedNode } from '../src/budget.ts'
import type { CanvasNodeId } from '@deepseek-ai/dsh-canvas'

const node = (id: string, kind: PlannedNode['kind'], calls = 1, extra: Partial<PlannedNode> = {}): PlannedNode => ({
  node: id as CanvasNodeId, kind, model: 'm', calls, lines: 1, ...extra,
})

const plan = (nodes: readonly PlannedNode[]): GenerationPlan => ({ nodes, create: [], stale: [], segments: [] })

const limits = {
  confirmVideoCalls: 2,
  confirmVideoSeconds: 20,
  confirmSpeechLines: 20,
  confirmImageCalls: 8,
  confirmMusicCalls: 2,
}

describe('canonicalJson', () => {
  it('sorts keys so the same plan is one string', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(undefined)).toBe('null')
  })
})

describe('confirmToken', () => {
  it('is stable for the same plan and changes with the plan', () => {
    const first = plan([node('n1', 'video', 1)])
    expect(confirmToken(first)).toHaveLength(16)
    expect(confirmToken({ ...first, nodes: [node('n1', 'video', 1)] })).toBe(confirmToken(first))
    expect(confirmToken({ ...first, nodes: [node('n1', 'video', 2)] })).not.toBe(confirmToken(first))
  })
})

describe('totals and confirmation', () => {
  it('sums each kind with its own unit', () => {
    expect(totalsOf([
      node('n0', 'video', 1),
      node('n1', 'video', 2, { seconds: 5 }),
      node('n2', 'video', 1, { seconds: 12.5 }),
      node('n3', 'image', 3),
      node('n4', 'speech', 1, { lines: 4 }),
      node('n6', 'speech', 2, { lines: 2 }),
      node('n5', 'music', 1),
    ])).toEqual({ videoCalls: 4, videoSeconds: 17.5, imageCalls: 3, speechLines: 6, musicCalls: 1 })
  })

  it('asks for confirmation at the threshold and not one below it', () => {
    expect(needsConfirmation({ ...limits, confirmVideoCalls: 2, videoCalls: 2 } as never, limits)).toBe(true)
    expect(needsConfirmation({ ...limits, confirmVideoCalls: 2, videoCalls: 1 } as never, limits)).toBe(false)
    const base = { videoCalls: 0, videoSeconds: 0, imageCalls: 0, speechLines: 0, musicCalls: 0 }
    expect(needsConfirmation({ ...base, imageCalls: 8 }, limits)).toBe(true)
    expect(needsConfirmation({ ...base, imageCalls: 7 }, limits)).toBe(false)
    expect(needsConfirmation({ ...base, speechLines: 20 }, limits)).toBe(true)
    expect(needsConfirmation({ ...base, musicCalls: 2 }, limits)).toBe(true)
    expect(needsConfirmation({ ...base, videoSeconds: 20 }, limits)).toBe(true)
    expect(needsConfirmation(base, limits)).toBe(false)
  })

  it('builds the budget a caller shows', () => {
    const budget = budgetOf(plan([node('n1', 'video', 2, { seconds: 10 })]), limits)
    expect(budget.totals.videoCalls).toBe(2)
    expect(budget.needsConfirmation).toBe(true)
    expect(budget.token).toBe(confirmToken(plan([node('n1', 'video', 2, { seconds: 10 })])))
  })
})
