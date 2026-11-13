import { describe, expect, it } from 'vitest'
import { planShotSegments, shotSegmentKind } from '../src/segments.ts'
import type { Shot } from '../src/types.ts'

/** One shot with the fields the planner reads. */
function shot(id: string, overrides: Partial<Shot> = {}): Shot {
  return {
    id: id as Shot['id'],
    title: id,
    shotSize: 'medium',
    visual: '林夏站在雨里，画面右侧三分之一',
    motion: '她把信封贴上胸口，低头',
    camera: '轻微手持晃动',
    durationSec: 3,
    characters: [],
    props: [],
    dialogue: [],
    sfx: '雨声',
    negative: '',
    ...overrides,
  }
}

/**
 * The reference fixture from dsh-infinite_canvas `scripts/test-segment-plan.mjs` (RUN), with its
 * `seg`/`duration` fields replaced by this package's cues. The reference implementation splits it
 * into two segments of 15s and 13.5s.
 */
function referenceRun(): Shot[] {
  return [
    shot('s1', { title: '起' }),
    shot('s2'),
    shot('s3'),
    shot('s4'),
    shot('s5'),
    shot('s6', { title: '换场', visual: '邮局内，换场后的第一镜', durationSec: 4 }),
    shot('s7', { visual: '邮局内继续', durationSec: 4 }),
    shot('s8', { visual: '邮局内继续', durationSec: 4 }),
    shot('s9', { title: '特写', visual: '信封上的字', shotSize: 'insert', durationSec: 1.5 }),
  ]
}

describe('shotSegmentKind', () => {
  it('classifies the first shot as the opening', () => {
    expect(shotSegmentKind(shot('s1'), undefined)).toBe('opening')
  })

  it('infers a scene change, a new character, a close shot, and a plain continuation', () => {
    const previous = shot('s1')
    expect(shotSegmentKind(shot('s2', { visual: '切至 邮局门口' }), previous)).toBe('scene_change')
    expect(shotSegmentKind(shot('s2', { visual: '陈默推门进来' }), previous)).toBe('new_character')
    expect(shotSegmentKind(shot('s2', { shotSize: 'extreme_close' }), previous)).toBe('closeup')
    expect(shotSegmentKind(shot('s2', { durationSec: 1 }), previous)).toBe('closeup')
    expect(shotSegmentKind(shot('s2', { durationSec: 1, dialogue: [{ id: 'd1' as never, speaker: { kind: 'narrator' }, line: 'x' }] }), previous)).toBe('continuation')
    expect(shotSegmentKind(shot('s2'), previous)).toBe('continuation')
  })
})

describe('planShotSegments', () => {
  it('splits the reference fixture into the segments the ported algorithm recorded', () => {
    const plan = planShotSegments(referenceRun(), { maxSegmentSec: 15 })
    expect(plan.segments.map(segment => [segment.index, segment.durationSec, segment.kind, segment.join, segment.needsTailChain])).toEqual([
      [0, 15, 'opening', 'strict', false],
      [1, 13.5, 'scene_change', 'loose', false],
    ])
    expect(plan.segments.map(segment => segment.shots)).toEqual([
      ['s1', 's2', 's3', 's4', 's5'],
      ['s6', 's7', 's8', 's9'],
    ])
    expect(plan.totalSec).toBe(28.5)
    expect(plan.cutMode).toBe('clean')
    expect(plan.warnings).toEqual([])
  })

  it('cuts a continuation run with no cut point and chains what follows', () => {
    const shots = [1, 2, 3, 4, 5, 6].map(index => shot(`s${String(index)}`))
    const plan = planShotSegments(shots, { maxSegmentSec: 15 })
    // The ported algorithm keeps the opening shot as its own segment when no later shot is a cut
    // point: the following segment starts mid-shot and therefore chains its tail frame.
    expect(plan.segments.map(segment => [segment.durationSec, segment.needsTailChain])).toEqual([[3, false], [15, true]])
    expect(plan.cutMode).toBe('forced')
    expect(plan.warnings[0]).toContain('starts mid-shot')
  })

  it('lets a cut shot open the next segment instead of ending the previous one', () => {
    const shots = [
      shot('s1'), shot('s2'), shot('s3'),
      shot('s4', { shotSize: 'insert', durationSec: 1.5 }),
      shot('s5'),
    ]
    const plan = planShotSegments(shots, { maxSegmentSec: 9 })
    // 9s of continuation, then the insert opens its own segment together with what follows.
    expect(plan.segments.map(segment => segment.shots)).toEqual([['s1', 's2', 's3'], ['s4', 's5']])
    expect(plan.segments[1]?.kind).toBe('closeup')
    expect(plan.segments[1]?.needsTailChain).toBe(false)
  })

  it('merges a tiny tail segment back when it fits the tolerance', () => {
    const shots = [shot('s1', { durationSec: 13 }), shot('s2', { durationSec: 3 })]
    const plan = planShotSegments(shots, { maxSegmentSec: 15 })
    expect(plan.segments.map(segment => [segment.durationSec, segment.shots])).toEqual([[16, ['s1', 's2']]])
    expect(plan.warnings.join(' ')).toContain('tail segment was merged')
  })

  it('generates an over-long single shot on its own with a warning', () => {
    const plan = planShotSegments([shot('s1', { durationSec: 20 })], { maxSegmentSec: 15 })
    expect(plan.segments).toHaveLength(1)
    expect(plan.warnings.join(' ')).toContain('over the 15s limit')
  })

  it('falls back to a default duration for a shot that states none', () => {
    expect(planShotSegments([shot('s1', { durationSec: 0 })]).totalSec).toBe(3)
  })

  it('ignores shots without a picture, an action, or a line', () => {
    const plan = planShotSegments([
      shot('s1'),
      shot('s2', { visual: '', motion: '', dialogue: [] }),
    ])
    expect(plan.segments.flatMap(segment => segment.shots)).toEqual(['s1'])
  })

  it('reports an empty table', () => {
    expect(planShotSegments([])).toEqual({
      segments: [],
      totalSec: 0,
      maxSegmentSec: 15,
      cutMode: 'empty',
      warnings: ['the storyboard has no usable shots'],
    })
  })

  it('honours the deployment bounds', () => {
    const shots = Array.from({ length: 4 }, (_unused, index) => shot(`s${String(index + 1)}`))
    const plan = planShotSegments(shots, { maxSegmentSec: 6, minSegmentSec: 1 })
    expect(plan.segments.flatMap(segment => segment.shots)).toEqual(['s1', 's2', 's3', 's4'])
    expect(plan.segments.every(segment => segment.durationSec <= 6)).toBe(true)
    expect(plan.cutMode).toBe('forced')
    expect(planShotSegments(shots, { maxSegmentSec: 0, minSegmentSec: -4 }).maxSegmentSec).toBe(15)
  })
})
