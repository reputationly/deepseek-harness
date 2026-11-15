/** Timeline gestures capture their original revision and submit the same commands as the Agent. */
import { useState, type PointerEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CanvasDocument,
  Timeline,
  TimelineClip,
  TimelineClipId,
  TimelineOperation,
  TimelineTrackId,
} from '@deepseek-ai/dsh-canvas/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { clipId, clipName, seconds, trackAccepts, trackId } from './timeline-model.ts'
import type { NS } from './locales.ts'
import css from './TimelineEditor.module.css'

export type TimelineTracksProps = PropsLocale<typeof NS> & {
  readonly document: Timeline
  readonly canvas: CanvasDocument
  readonly selected: TimelineClipId | undefined
  readonly playhead: number
  readonly disabled: boolean
  readonly select: (clip: TimelineClip) => void
  readonly selectTrack: (track: TimelineTrackId) => void
  readonly seek: (ms: number) => void
  readonly apply: (operations: readonly TimelineOperation[], revision: number) => Promise<boolean>
  readonly removeTrack: (track: TimelineTrackId) => void
}
interface Drag {
  readonly clip: TimelineClip
  readonly track: TimelineTrackId
  readonly revision: number
  readonly pointer: number
  readonly x: number
  readonly delta: number
  readonly target: TimelineTrackId
}

/** Short clips also appear in a select control, providing a full-size keyboard and touch target. */
export function TimelineTracks({
  document,
  canvas,
  selected,
  playhead,
  disabled,
  select,
  selectTrack,
  seek,
  apply,
  removeTrack,
  t,
}: TimelineTracksProps) {
  const [zoom, setZoom] = useState(80)
  const [drag, setDrag] = useState<Drag>()
  const duration = document.tracks.reduce(
    (end, track) => track.clips.reduce((tail, clip) => Math.max(tail, clip.startMs + clip.durationMs), end),
    0,
  )
  const length = Math.max(10_000, duration + 2000)
  const width = Math.max(600, (length / 1000) * zoom)
  const entries = document.tracks.flatMap(track => track.clips.map(clip => ({ track, clip })))
  const entry = entries.find(entry => entry.clip.id === selected)
  const startDrag = (event: PointerEvent<HTMLButtonElement>, clip: TimelineClip, track: TimelineTrackId): void => {
    if (disabled || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({
      clip,
      track,
      target: track,
      revision: document.revision,
      pointer: event.pointerId,
      x: event.clientX,
      delta: 0,
    })
  }
  const moveDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    if (drag === undefined || event.pointerId !== drag.pointer) return
    const targetId = window.document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest('[data-timeline-track]')
      ?.getAttribute('data-timeline-track')
    const target = document.tracks.find(track => track.id === targetId && trackAccepts(track, drag.clip, canvas))
    setDrag({ ...drag, delta: event.clientX - drag.x, target: target?.id ?? drag.track })
  }
  const endDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    if (drag === undefined || event.pointerId !== drag.pointer) return
    const accepted = drag
    setDrag(undefined)
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (Math.abs(accepted.delta) < 4 && accepted.target === accepted.track) return
    void apply(
      [
        {
          op: 'move_clip',
          clip: accepted.clip.id,
          track: accepted.target,
          startMs: Math.max(0, accepted.clip.startMs + Math.round((accepted.delta / zoom) * 1000)),
        },
      ],
      accepted.revision,
    )
  }
  return (
    <section className={css.tracks} aria-label={t('editor.tracks')}>
      <div className={css.toolbar}>
        {(['video', 'audio', 'text'] as const).map(kind => (
          <Button
            key={kind}
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              const id = trackId()
              void apply(
                [{ op: 'add_track', track: { id, kind, muted: false, volume: 1, clips: [] } }],
                document.revision,
              ).then((ok) => {
                if (ok) selectTrack(id)
              })
            }}
          >
            {t(trackLabels[kind])}
          </Button>
        ))}
        <label className={css.field}>
          <span>{t('editor.selectClip')}</span>
          <select
            className={css.input}
            value={selected ?? ''}
            disabled={disabled}
            onChange={(event) => {
              const found = entries.find(entry => entry.clip.id === event.target.value)
              if (found !== undefined) select(found.clip)
            }}
          >
            <option value="">{t('editor.none')}</option>
            {entries.map(({ clip }) => (
              <option value={clip.id} key={clip.id}>
                {clipName(clip, canvas)}
              </option>
            ))}
          </select>
        </label>
        <label className={css.field}>
          <span>{t('editor.seek')}</span>
          <input
            className={css.input}
            type="number"
            min={0}
            max={duration / 1000}
            step="0.001"
            value={seconds(Math.min(playhead, duration))}
            onChange={(event) => {
              if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber))
                seek(Math.max(0, Math.min(duration, Math.round(event.target.valueAsNumber * 1000))))
            }}
          />
        </label>
        <label className={css.field}>
          <span>{t('editor.zoom')}</span>
          <input
            type="range"
            min={20}
            max={200}
            value={zoom}
            onChange={(event) => {
              setZoom(event.target.valueAsNumber)
            }}
          />
        </label>
      </div>
      <div className={css.actions}>
        <Button
          size="sm"
          disabled={
            disabled ||
            entry === undefined ||
            playhead <= entry.clip.startMs ||
            playhead >= entry.clip.startMs + entry.clip.durationMs
          }
          onClick={() => {
            if (entry !== undefined)
              void apply(
                [{ op: 'split_clip', clip: entry.clip.id, atMs: playhead, rightId: clipId() }],
                document.revision,
              )
          }}
        >
          {t('editor.split')}
        </Button>
        <Button
          size="sm"
          disabled={disabled || entry === undefined}
          onClick={() => {
            if (entry !== undefined) void apply([{ op: 'remove_clip', clip: entry.clip.id }], document.revision)
          }}
        >
          {t('editor.removeClip')}
        </Button>
        <Button
          size="sm"
          disabled={disabled || entry === undefined}
          onClick={() => {
            if (entry !== undefined) void apply([{ op: 'ripple_delete', clip: entry.clip.id }], document.revision)
          }}
        >
          {t('editor.ripple')}
        </Button>
      </div>
      <div className={css.scroll}>
        {document.tracks.length === 0 && <p className={css.hint}>{t('editor.emptyTracks')}</p>}
        {document.tracks.map(track => (
          <div key={track.id} className={css.trackRow} data-timeline-track={track.id}>
            <div className={css.trackHeader}>
              <button
                type="button"
                className={css.trackName}
                onClick={() => {
                  selectTrack(track.id)
                }}
              >
                {t(trackLabels[track.kind])}
              </button>
              <div className={css.trackActions}>
                <Button
                  size="sm"
                  disabled={disabled}
                  aria-pressed={track.muted}
                  onClick={() => {
                    void apply([{ op: 'set_track', track: track.id, muted: !track.muted }], document.revision)
                  }}
                >
                  {t(track.muted ? 'editor.unmute' : 'editor.mute')}
                </Button>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    removeTrack(track.id)
                  }}
                >
                  {t('editor.removeTrack')}
                </Button>
              </div>
            </div>
            <div
              className={css.lane}
              style={{ width }}
              onClick={(event) => {
                if (event.target === event.currentTarget)
                  seek(
                    Math.max(
                      0,
                      Math.min(
                        duration,
                        Math.round(((event.clientX - event.currentTarget.getBoundingClientRect().left) / zoom) * 1000),
                      ),
                    ),
                  )
              }}
            >
              <div className={css.playhead} style={{ left: (playhead / 1000) * zoom }} />
              {track.clips.map(clip => (
                <button
                  key={clip.id}
                  type="button"
                  className={css.clip}
                  disabled={disabled}
                  aria-pressed={selected === clip.id}
                  style={{
                    left: Math.max(0, (clip.startMs / 1000) * zoom + (drag?.clip.id === clip.id ? drag.delta : 0)),
                    width: Math.max(2, (clip.durationMs / 1000) * zoom),
                  }}
                  aria-label={t('editor.clipLabel', {
                    name: clipName(clip, canvas),
                    start: seconds(clip.startMs),
                    duration: seconds(clip.durationMs),
                  })}
                  onClick={() => {
                    select(clip)
                  }}
                  onPointerDown={(event) => {
                    startDrag(event, clip, track.id)
                  }}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={() => {
                    setDrag(undefined)
                  }}
                  onLostPointerCapture={() => {
                    setDrag(undefined)
                  }}
                >
                  {clipName(clip, canvas)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
export const trackLabels = { video: 'editor.video', audio: 'editor.audio', text: 'editor.text' } as const
