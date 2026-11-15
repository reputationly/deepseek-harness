import { describe, expect, it } from 'vitest'
import { asResult, renderResult } from '../src/result-view.ts'

describe('asResult', () => {
  it('narrows each status to its discriminated result', () => {
    expect(asResult({ status: 'blocked', gate: 'G2', missing: ['x'] }))
      .toEqual({ status: 'blocked', gate: 'G2', missing: ['x'] })
    expect(asResult({ status: 'already_running', jobs: [{ node: 'n1', jobId: 'j1' }] }))
      .toEqual({ status: 'already_running', jobs: [{ node: 'n1', jobId: 'j1' }] })
    expect(asResult({ status: 'started', jobs: [{ node: 'n1', jobId: 'j1' }] }))
      .toEqual({ status: 'started', jobs: [{ node: 'n1', jobId: 'j1' }] })
  })

  it('defaults a blocked gate and started jobs', () => {
    expect(asResult({ status: 'blocked' })).toEqual({ status: 'blocked', gate: 'G4_stage_order', missing: [] })
    expect(asResult({ status: 'started' })).toEqual({ status: 'started', jobs: [] })
  })
})

describe('renderResult', () => {
  it('renders the blocked gate and its missing referents', () => {
    expect(renderResult({ status: 'blocked', gate: 'G2_storyboard_quality', missing: ['shot s1'] }))
      .toBe('Generation blocked (G2_storyboard_quality): shot s1')
  })

  it('renders started jobs and the jobs notice', () => {
    const text = renderResult({ status: 'started', jobs: [{ node: 'n1', jobId: 'j1' }] })
    expect(text).toContain('Started 1 generation job(s): n1 (j1)')
    expect(text).toContain('A notice arrives')
  })

  it('renders already-running nodes', () => {
    expect(renderResult({ status: 'already_running', jobs: [{ node: 'n1', jobId: 'j1' }] }))
      .toContain('already have a generation job')
  })
})
