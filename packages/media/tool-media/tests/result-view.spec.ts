import { describe, expect, it } from 'vitest'
import { asResult, budgetView, renderResult } from '../src/result-view.ts'
import type { Budget } from '../src/budget.ts'
import type { CanvasNodeId } from '@deepseek-ai/dsh-canvas'

const budget: Budget = {
  token: 'abc123',
  needsConfirmation: true,
  lines: [
    { node: 'n1' as CanvasNodeId, kind: 'video', model: 'm', calls: 1, seconds: 6, lines: 1 },
    { node: 'n2' as CanvasNodeId, kind: 'speech', model: 's', calls: 1, lines: 2 },
    { node: 'n3' as CanvasNodeId, kind: 'image', model: 'i', calls: 1, lines: 1 },
  ],
  totals: { videoCalls: 1, videoSeconds: 6, imageCalls: 1, speechLines: 2, musicCalls: 0 },
}

describe('budgetView', () => {
  it('fills the optional units with zero so every line has the same fields', () => {
    expect(budgetView(budget).lines).toEqual([
      { node: 'n1', kind: 'video', model: 'm', calls: 1, seconds: 6, lines: 1 },
      { node: 'n2', kind: 'speech', model: 's', calls: 1, seconds: 0, lines: 2 },
      { node: 'n3', kind: 'image', model: 'i', calls: 1, seconds: 0, lines: 1 },
    ])
  })
})

describe('asResult', () => {
  it('narrows each status and defaults a blocked result without details', () => {
    expect(asResult({ status: 'blocked' })).toEqual({ status: 'blocked', gate: 'G4_stage_order', missing: [] })
    expect(asResult({ status: 'blocked', gate: 'G2_storyboard_quality', missing: ['x'] }))
      .toEqual({ status: 'blocked', gate: 'G2_storyboard_quality', missing: ['x'] })
    expect(asResult({ status: 'needs_confirmation', budget: budgetView(budget) }))
      .toEqual({ status: 'needs_confirmation', budget: budgetView(budget) })
    expect(asResult({ status: 'already_running', jobs: [{ node: 'n1', jobId: 'j1' }] }))
      .toEqual({ status: 'already_running', jobs: [{ node: 'n1', jobId: 'j1' }] })
    expect(asResult({ status: 'started' })).toEqual({ status: 'started', jobs: [] })
    expect(asResult({ status: 'already_running' })).toEqual({ status: 'already_running', jobs: [] })
  })

  it('refuses a confirmation result without its budget', () => {
    expect(() => asResult({ status: 'needs_confirmation' })).toThrow('needs its budget')
  })
})

describe('renderResult', () => {
  it('renders every status as one sentence', () => {
    expect(renderResult({ status: 'blocked', gate: 'G2_storyboard_quality', missing: ['a', 'b'] }))
      .toBe('Generation blocked (G2_storyboard_quality): a; b')
    expect(renderResult({ status: 'already_running', jobs: [{ node: 'n1', jobId: 'j1' }] })).toContain('already have a generation job')
    expect(renderResult({ status: 'started', jobs: [{ node: 'n1', jobId: 'j1' }] })).toContain('Started 1 generation job')
    const asked = renderResult({ status: 'needs_confirmation', budget: budgetView(budget) })
    expect(asked).toContain('needs confirmation')
    expect(asked).toContain('confirmToken abc123')
    expect(asked).toContain('n1 video m ×1')
  })
})
