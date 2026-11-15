import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { mixTimelineAudio, timelineFramesAt, timelineGain } from '../src/index.ts'
import type { CanvasNodeId, Timeline, TimelineClip, TimelineClipId, TimelineTrackId, VersionId } from '@deepseek-ai/dsh-canvas/client'

const clip: TimelineClip = { id: brandString<TimelineClipId>('k1'), startMs: 1000, durationMs: 2000,
  source: { node: brandString<CanvasNodeId>('n1'), version: brandString<VersionId>('v2'), inMs: 700 }, volume: 0.5, fadeInMs: 500, fadeOutMs: 500 }
const timeline: Timeline = { version: 1, revision: 1, spec: { width: 720, height: 1280, fps: 24 },
  tracks: [{ id: brandString<TimelineTrackId>('t1'), kind: 'video', muted: false, volume: 0.5, clips: [clip] }] }

it('evaluates half-open clip intervals and includes the pinned source in-point', () => {
  expect(timelineFramesAt(timeline, 999)).toEqual([])
  expect(timelineFramesAt(timeline, 1000)).toEqual([{ clip, sourceMs: 700 }])
  expect(timelineFramesAt(timeline, 2500)).toEqual([{ clip, sourceMs: 2200 }])
  expect(timelineFramesAt(timeline, 3000)).toEqual([])
  expect(timelineFramesAt({ ...timeline, tracks: timeline.tracks.map(t => ({ ...t, muted: true })) }, 1000)).toEqual([])
})
it('applies both clip volume and the complete fade envelope', () => {
  expect([500, 1000, 1250, 1500, 2000, 2750, 3000].map(time => timelineGain(clip, time))).toEqual([0, 0, 0.25, 0.5, 0.5, 0.25, 0])
})
it('mixes only active samples, combines track/clip gains and retains silence outside clips', () => {
  const buffers = mixTimelineAudio(timeline, 0, 4000, 1000, 2, (_clip, sourceMs, channel) => sourceMs / 1000 * (channel === 0 ? 1 : -1))
  expect(buffers[0]?.[999]).toBe(0)
  expect(buffers[0]?.[1000]).toBe(0)
  expect(buffers[0]?.[1500]).toBeCloseTo(0.3)
  expect(buffers[1]?.[1500]).toBeCloseTo(-0.3)
  expect(buffers[0]?.[2750]).toBeCloseTo(0.30625)
  expect(buffers[0]?.[3000]).toBe(0)
})
it('produces the same samples for a complete window and adjoining bounded windows', () => {
  const sample = (_clip: TimelineClip, sourceMs: number): number => Math.sin(sourceMs / 30)
  const full = mixTimelineAudio(timeline, 0, 4000, 1000, 1, sample)[0]
  const first = mixTimelineAudio(timeline, 0, 1753, 1000, 1, sample)[0]
  const second = mixTimelineAudio(timeline, 1753, 2247, 1000, 1, sample)[0]
  expect(full?.slice(0, 1753)).toEqual(first)
  expect(full?.slice(1753)).toEqual(second)
})
it('mixes tracks before limiting and excludes muted and text tracks', () => {
  const source = { ...clip, volume: 1, fadeInMs: 0, fadeOutMs: 0 }
  const mixed = { ...timeline, tracks: [
    { ...timeline.tracks[0]!, volume: 1, clips: [source] },
    { ...timeline.tracks[0]!, id: brandString<TimelineTrackId>('t2'), volume: 1, clips: [{ ...source, id: brandString<TimelineClipId>('k2') }] },
    { ...timeline.tracks[0]!, id: brandString<TimelineTrackId>('t3'), volume: 1, muted: true, clips: [{ ...source, id: brandString<TimelineClipId>('k3') }] },
  ] }
  const output = mixTimelineAudio(mixed, 1000, 2, 1000, 1, c => c.id === 'k1' ? 2 : -1.5)
  expect(output[0]).toEqual(new Float32Array([0.5, 0.5]))
})
