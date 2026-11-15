import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { applyTimeline, parseTimeline, timelineDuration } from '../src/timeline.ts'
import type { Timeline, TimelineClip, TimelineTrackId } from '../src/timeline-types.ts'
import type { CanvasNodeId, TimelineClipId, VersionId } from '../src/types.ts'

const t = (value: string): TimelineTrackId => brandString<TimelineTrackId>(value)
const k = (value: string): TimelineClipId => brandString<TimelineClipId>(value)
const clip: TimelineClip = { id: k('k1'), startMs: 1000, durationMs: 4000,
  source: { node: brandString<CanvasNodeId>('n1'), version: brandString<VersionId>('v1'), inMs: 500 }, fadeInMs: 500, fadeOutMs: 500 }
const base: Timeline = { version: 1, revision: 3, spec: { width: 720, height: 1280, fps: 24 },
  tracks: [{ id: t('t1'), kind: 'video', muted: false, volume: 1, clips: [clip] },
    { id: t('t2'), kind: 'video', muted: false, volume: 1, clips: [] }] }

describe('timeline document', () => {
  it('keeps pinned versions and all timing on disk round trips', () => {
    expect(parseTimeline(JSON.stringify(base))).toEqual(base)
    expect(timelineDuration(base)).toBe(5000)
  })
  it.each(['v_import_52748536834ae71c5a843897', `local-${'7'.repeat(64)}`, 'generated-video:42'])('retains opaque source version %s through editing and disk round trips', (version) => {
    const added = { ...clip, id: k('k2'), source: { ...clip.source!, version: brandString<VersionId>(version) } }
    const edited = applyTimeline(base, [{ op: 'add_clip', track: t('t1'), clip: added }], base.revision).document
    expect(parseTimeline(JSON.stringify(edited)).tracks[0]?.clips[1]).toEqual(added)
  })
  it.each([
    { revision: -1 }, { spec: { width: 721, height: 1280, fps: 24 } },
    { spec: { width: 720, height: 1280, fps: 29.97 } }, { extra: true }, { version: 99 },
  ])('rejects malformed or unsupported documents: %j', (patch) => {
    expect(() => parseTimeline(JSON.stringify({ ...base, ...patch }))).toThrow()
  })
  it.each([
    { durationMs: 0 }, { startMs: -1 }, { fadeInMs: 5001 }, { opacity: 2 }, { source: { node: '../n1', version: 'v1', inMs: 0 } },
    { source: { node: 'n1', version: 'v1', inMs: -1 } }, { source: { node: 'n1', version: 42, inMs: 0 } },
    { startMs: Number.MAX_SAFE_INTEGER }, { volume: null }, { unknown: true },
  ])('rejects invalid clips instead of silently discarding fields: %j', (patch) => {
    expect(() => parseTimeline(JSON.stringify({ ...base, tracks: [{ ...base.tracks[0], clips: [{ ...clip, ...patch }] }] }))).toThrow()
  })
  it('refuses duplicate clip ids across different tracks', () => {
    expect(() => parseTimeline(JSON.stringify({ ...base, tracks: base.tracks.map(track => ({ ...track, clips: [clip] })) }))).toThrow('duplicate clip')
  })
  it('refuses media clips on text tracks', () => {
    expect(() => parseTimeline(JSON.stringify({ ...base, tracks: [{ ...base.tracks[0], kind: 'text' }] }))).toThrow('does not match')
  })
})

describe('timeline editing', () => {
  it('moves clips between tracks and invalidates only old and new intervals', () => {
    const edited = applyTimeline(base, [{ op: 'move_clip', clip: k('k1'), track: t('t2'), startMs: 10000 }], 3)
    expect(edited.document.revision).toBe(4)
    expect(edited.document.tracks[0]?.clips).toEqual([])
    expect(edited.document.tracks[1]?.clips[0]?.source).toEqual(clip.source)
    expect(edited.invalidated).toEqual([{ fromMs: 1000, toMs: 5000 }, { fromMs: 10000, toMs: 14000 }])
    expect(base.tracks[0]?.clips).toEqual([clip])
  })
  it('splits without losing source offsets or adding a new transition', () => {
    const result = applyTimeline(base, [{ op: 'split_clip', clip: k('k1'), atMs: 2500, rightId: k('k2') }], 3)
    expect(result.document.tracks[0]?.clips).toMatchObject([
      { id: 'k1', startMs: 1000, durationMs: 1500, source: { inMs: 500 }, fadeOutMs: 0 },
      { id: 'k2', startMs: 2500, durationMs: 2500, source: { inMs: 2000 }, fadeInMs: 0, transitionIn: { type: 'cut', durationMs: 0 } },
    ])
    expect(timelineDuration(result.document)).toBe(timelineDuration(base))
  })
  it('rejects a stale revision before any command is applied', () => {
    expect(() => applyTimeline(base, [{ op: 'remove_track', track: t('t1') }], 2)).toThrow('revision')
    expect(base.tracks).toHaveLength(2)
  })
  it('rejects a batch if a later command cannot apply, without modifying its input', () => {
    const before = JSON.stringify(base)
    expect(() => applyTimeline(base, [{ op: 'remove_clip', clip: k('k1') }, { op: 'remove_clip', clip: k('k99') }], 3)).toThrow('does not exist')
    expect(JSON.stringify(base)).toBe(before)
  })
  it('ripple-deletes later clips only on the edited track', () => {
    const populated = applyTimeline(base, [{ op: 'add_clip', track: t('t1'), clip: { ...clip, id: k('k2'), startMs: 7000 } },
      { op: 'add_clip', track: t('t2'), clip: { ...clip, id: k('k3'), startMs: 7000 } }], 3).document
    const result = applyTimeline(populated, [{ op: 'ripple_delete', clip: k('k1') }], 4)
    expect(result.document.tracks[0]?.clips[0]?.startMs).toBe(3000)
    expect(result.document.tracks[1]?.clips[0]?.startMs).toBe(7000)
    expect(result.invalidated).toEqual([{ fromMs: 1000, toMs: 11000 }])
  })
  it('coalesces overlapping invalidation ranges and bumps once per batch', () => {
    const result = applyTimeline(base, [{ op: 'set_clip', clip: k('k1'), patch: { volume: 0.5 } },
      { op: 'trim_clip', clip: k('k1'), inMs: 800, durationMs: 3000 }], 3)
    expect(result.document.revision).toBe(4)
    expect(result.invalidated).toEqual([{ fromMs: 1000, toMs: 5000 }])
  })
  it('makes an empty batch a read without a new revision', () => {
    expect(applyTimeline(base, [], 3)).toEqual({ document: base, invalidated: [] })
  })
})
