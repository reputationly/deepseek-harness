/** One deterministic scene evaluator for preview, cached frames, and final encoding. */
import type { Timeline, TimelineClip, TimelineClipId } from '@deepseek-ai/dsh-canvas/client'

/** Missing decoded media stops rendering; callers must not publish the incomplete frame. */
export class TimelineFrameError extends Error {
  /**
   * Structured failure category for a missing visible source frame.
   */
  readonly code = 'timeline/missing-frame'
  constructor(readonly clip: TimelineClipId) {
    super(`timeline frame for ${clip} is unavailable`)
    this.name = 'TimelineFrameError'
  }
}

/** The Canvas2D operations used by the compositor; no browser globals are required to evaluate a scene. */
export interface TimelineDrawingContext<Image> {
  globalAlpha: number
  fillStyle: string | object
  strokeStyle: string | object
  font: string
  textAlign: 'center' | 'start' | 'end' | 'left' | 'right'
  textBaseline: 'alphabetic' | 'top' | 'hanging' | 'middle' | 'ideographic' | 'bottom'
  lineWidth: number
  lineJoin: 'round' | 'bevel' | 'miter'
  reset(): void
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  beginPath(): void
  rect(x: number, y: number, width: number, height: number): void
  clip(): void
  fillRect(x: number, y: number, width: number, height: number): void
  drawImage(
    image: Image,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void
  measureText(text: string): { readonly width: number }
  fillText(text: string, x: number, y: number): void
  strokeText(text: string, x: number, y: number): void
}

/** Decoded media at the clip's requested source timestamp. The decoder owns disposal. */
export interface TimelineFrame<Image> {
  readonly image: Image
  readonly width: number
  readonly height: number
}

/** Output-independent styling resolved once per render, never from the application theme. */
export interface TimelineRenderStyle {
  readonly background: string
  readonly fontFamily: string
  readonly textColor: string
  readonly strokeColor: string
  readonly strokeWidth: number
  readonly textMargin: number
  readonly lineHeight: number
}

/**
 * Sources needed at an output timestamp; a muted track contributes neither picture nor sound.
 * @param timeline - Validated timeline being evaluated.
 * @param timeMs - Output timestamp in timeline milliseconds.
 * @returns Visible media clips and their source timestamps.
 */
export function timelineFramesAt(
  timeline: Timeline,
  timeMs: number,
): readonly { readonly clip: TimelineClip; readonly sourceMs: number }[] {
  return timeline.tracks.flatMap(track =>
    track.kind !== 'video' || track.muted
      ? []
      : track.clips
        .filter(
          clip => clip.source !== undefined && clip.startMs <= timeMs && timeMs < clip.startMs + clip.durationMs,
        )
        .map(clip => ({ clip, sourceMs: (clip.source?.inMs ?? 0) + timeMs - clip.startMs })),
  )
}

/**
 * A clamped linear audio envelope, evaluated in timeline milliseconds.
 * @param clip - Clip whose timing, source, or label is being evaluated.
 * @param timeMs - Output timestamp in timeline milliseconds.
 * @returns The clip gain after applying its fade envelope, or zero outside the clip.
 */
export function timelineGain(clip: TimelineClip, timeMs: number): number {
  const relative = timeMs - clip.startMs
  if (relative < 0 || relative >= clip.durationMs) return 0
  const fadeIn = clip.fadeInMs === undefined || clip.fadeInMs === 0 ? 1 : Math.min(1, relative / clip.fadeInMs)
  const fadeOut =
    clip.fadeOutMs === undefined || clip.fadeOutMs === 0
      ? 1
      : Math.min(1, (clip.durationMs - relative) / clip.fadeOutMs)
  return (clip.volume ?? 1) * fadeIn * fadeOut
}

function linesOf(text: string, width: number, measure: (text: string) => number): string[] {
  const result: string[] = []
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const { segment } of segmenter.segment(paragraph)) {
      if (line !== '' && measure(line + segment) > width) {
        result.push(line)
        line = ''
      }
      line += segment
    }
    result.push(line)
  }
  return result
}

function paintText<Image>(
  ctx: TimelineDrawingContext<Image>,
  clip: TimelineClip,
  width: number,
  height: number,
  style: TimelineRenderStyle,
): void {
  const text = clip.text
  if (text === undefined) return
  ctx.font = `${String(text.size)}px ${text.fontFamily ?? style.fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.lineJoin = 'round'
  ctx.fillStyle = text.color ?? style.textColor
  ctx.strokeStyle = text.strokeColor ?? style.strokeColor
  ctx.lineWidth = text.strokeWidth ?? style.strokeWidth
  const lines = linesOf(
    text.content,
    Math.max(1, width - style.textMargin * 2),
    value => ctx.measureText(value).width,
  )
  const lineHeight = text.size * (text.lineHeight ?? style.lineHeight)
  const blockHeight = lines.length * lineHeight
  const top =
    text.position === 'top'
      ? style.textMargin
      : text.position === 'center'
        ? (height - blockHeight) / 2
        : height - style.textMargin - blockHeight
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (ctx.lineWidth > 0) ctx.strokeText(line, width / 2, top + i * lineHeight)
    ctx.fillText(line, width / 2, top + i * lineHeight)
  }
}

/**
 * Draw one complete output frame. The caller must await fonts and decoded inputs before calling.
 * Missing visible media is an error, so an incomplete picture cannot become a valid cache entry.
 * @param ctx - Drawing context receiving the composed output frame.
 * @param timeline - Validated timeline being evaluated.
 * @param timeMs - Output timestamp in timeline milliseconds.
 * @param frames - Decoded frames keyed by clip identity for this timestamp.
 * @param style - Shared font, caption, and background rendering rules.
 */
export function paintTimeline<Image>(
  ctx: TimelineDrawingContext<Image>,
  timeline: Timeline,
  timeMs: number,
  frames: ReadonlyMap<TimelineClipId, TimelineFrame<Image>>,
  style: TimelineRenderStyle,
): void {
  const { width, height } = timeline.spec
  ctx.reset()
  ctx.fillStyle = style.background
  ctx.fillRect(0, 0, width, height)
  for (const track of timeline.tracks) {
    if (track.muted || track.kind === 'audio') continue
    for (const clip of track.clips) {
      if (timeMs < clip.startMs || timeMs >= clip.startMs + clip.durationMs) continue
      const relative = timeMs - clip.startMs
      const transition = clip.transitionIn
      const alpha =
        transition === undefined || transition.type === 'cut' || transition.durationMs === 0
          ? 1
          : Math.min(1, relative / transition.durationMs)
      const transform = clip.transform ?? { x: 0, y: 0, width, height, rotation: 0 }
      ctx.save()
      try {
        ctx.translate(transform.x + transform.width / 2, transform.y + transform.height / 2)
        ctx.rotate((transform.rotation * Math.PI) / 180)
        ctx.translate(-transform.width / 2, -transform.height / 2)
        ctx.beginPath()
        ctx.rect(0, 0, transform.width, transform.height)
        ctx.clip()
        ctx.globalAlpha = clip.opacity ?? 1
        if (transition?.type === 'fade_black' && alpha < 1) {
          ctx.fillStyle = style.background
          ctx.fillRect(0, 0, transform.width, transform.height)
        }
        ctx.globalAlpha *= alpha
        if (track.kind === 'text') {
          paintText(ctx, clip, transform.width, transform.height, style)
          continue
        }
        const frame = frames.get(clip.id)
        if (frame === undefined) throw new TimelineFrameError(clip.id)
        const progress = relative / clip.durationMs
        const still = clip.still
        let zoom = 1,
          panX = 0,
          panY = 0
        if (still !== undefined && still.type !== 'static') {
          zoom =
            still.type === 'zoom_in'
              ? 1 + still.strength * progress
              : still.type === 'zoom_out'
                ? 1 + still.strength * (1 - progress)
                : 1 + still.strength
          if (still.type === 'pan_left') panX = 1 - progress * 2
          if (still.type === 'pan_right') panX = progress * 2 - 1
          if (still.type === 'pan_up') panY = 1 - progress * 2
          if (still.type === 'pan_down') panY = progress * 2 - 1
        }
        const scale =
          (clip.fit === 'cover' ? Math.max : Math.min)(transform.width / frame.width, transform.height / frame.height) *
          zoom
        const w = frame.width * scale,
          h = frame.height * scale
        const dx = (transform.width - w) / 2 + (Math.max(0, w - transform.width) * panX) / 2
        const dy = (transform.height - h) / 2 + (Math.max(0, h - transform.height) * panY) / 2
        ctx.drawImage(frame.image, 0, 0, frame.width, frame.height, dx, dy, w, h)
      } finally {
        ctx.restore()
      }
    }
  }
}

/**
 * Mix a bounded PCM window. The provider has already decoded and resampled the window's inputs.
 * Sample callbacks use source milliseconds, including the clip's in-point. Accumulation precedes
 * the final limiter, so intermediate clipping cannot discard another track's contribution.
 * @param timeline - Validated timeline being evaluated.
 * @param startSample - First output sample index.
 * @param count - Number of output samples per channel.
 * @param sampleRate - Output samples per second.
 * @param channels - Number of output audio channels.
 * @param sample - Reads one source sample for the clip, source timestamp, and channel.
 * @returns One planar PCM array per output channel.
 */
export function mixTimelineAudio(
  timeline: Timeline,
  startSample: number,
  count: number,
  sampleRate: number,
  channels: number,
  sample: (clip: TimelineClip, sourceMs: number, channel: number) => number,
): Float32Array[] {
  const output = Array.from({ length: channels }, () => new Float32Array(count))
  for (const track of timeline.tracks) {
    if (track.muted || track.kind === 'text') continue
    for (const clip of track.clips) {
      if (clip.source === undefined) continue
      const from = Math.max(0, Math.ceil((clip.startMs * sampleRate) / 1000) - startSample)
      const to = Math.min(count, Math.ceil(((clip.startMs + clip.durationMs) * sampleRate) / 1000) - startSample)
      for (let i = from; i < to; i++) {
        const time = ((startSample + i) * 1000) / sampleRate
        const gain = track.volume * timelineGain(clip, time)
        for (let channel = 0; channel < channels; channel++) {
          const buffer = output[channel]
          if (buffer !== undefined)
            buffer[i] = (buffer[i] ?? 0) + sample(clip, clip.source.inMs + time - clip.startMs, channel) * gain
        }
      }
    }
  }
  for (const buffer of output)
    for (let i = 0; i < buffer.length; i++) buffer[i] = Math.max(-1, Math.min(1, buffer[i] ?? 0))
  return output
}
