/** The browser codec adapter for the shared compositor. Preview and export consume its one final MP4. */
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  CanvasSink,
  CanvasSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamSource,
  StreamTarget,
} from 'mediabunny'
import {
  mixTimelineAudio,
  paintTimeline,
  timelineFramesAt,
  TimelineFrameError,
} from '@deepseek-ai/dsh-util-timeline-compositor'
import { TimelineRenderFailure } from './timeline-failure.ts'
import type { TimelineClip, TimelineClipId } from '@deepseek-ai/dsh-canvas/client'
import type { TimelineFrame } from '@deepseek-ai/dsh-util-timeline-compositor'
import type {
  TimelineRenderAsset,
  TimelineRenderBlock,
  TimelineRenderPart,
  TimelineRenderPlan,
  TimelineRenderWork,
} from '@deepseek-ai/dsh-api-remotes/client'

/** All bytes cross bounded workspace reads and leased Host writes; no output file is retained in memory. */
export interface TimelineRenderIO {
  readonly read: (path: string, offset: number, length: number, signal: AbortSignal) => Promise<Uint8Array>
  readonly size: (path: string, signal: AbortSignal) => Promise<number>
  readonly compatible: (asset: TimelineRenderAsset) => Promise<TimelineRenderAsset>
  readonly append: (part: TimelineRenderPart, offset: number, bytes: Uint8Array) => Promise<number>
  readonly complete: (part: TimelineRenderPart) => Promise<void>
  readonly progress: (fraction: number, assembling: boolean) => Promise<void>
  readonly report: (error: unknown) => void
}

function inputOf(
  path: string,
  size: number | undefined,
  plan: TimelineRenderPlan,
  io: TimelineRenderIO,
  signal: AbortSignal,
): Input<StreamSource> {
  return new Input({
    formats: ALL_FORMATS,
    source: new StreamSource({
      maxCacheSize: plan.sourceCacheBytes,
      getSize: () => size ?? io.size(path, signal),
      read: (start, end) =>
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              signal.throwIfAborted()
              if (start >= end) {
                controller.close()
                return
              }
              const length = Math.min(plan.maxChunkBytes, end - start)
              const bytes = await io.read(path, start, length, signal)
              if (bytes.byteLength !== length)
                throw new TimelineRenderFailure('source', 'Media source changed or ended during a range read')
              start += length
              controller.enqueue(bytes)
            } catch (error: unknown) {
              controller.error(error)
            }
          },
        }),
    }),
  })
}

async function smallFile(
  path: string,
  size: number,
  plan: TimelineRenderPlan,
  io: TimelineRenderIO,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (size > plan.maxImageBytes)
    throw new TimelineRenderFailure('source', 'Image or font exceeds the configured decoding limit')
  const bytes = new Uint8Array(size)
  for (let at = 0; at < size; at += plan.maxChunkBytes) {
    signal.throwIfAborted()
    const length = Math.min(plan.maxChunkBytes, size - at),
      part = await io.read(path, at, length, signal)
    if (part.byteLength !== length) throw new TimelineRenderFailure('source', 'Image or font changed while reading')
    bytes.set(part, at)
  }
  return bytes
}

interface MediaHandle {
  readonly input: Input<StreamSource> | undefined
  readonly image: ImageBitmap | undefined
  readonly video: CanvasSink | undefined
  readonly audio: AudioSampleSink | undefined
  readonly rate: number
  readonly duration: number
  dispose(): void
}

/** LRU by clip, so independently placed uses of a video never alias a recycled frame canvas. */
class MediaPool {
  private readonly media = new Map<TimelineClipId, MediaHandle>()
  private readonly opening = new Set<Input<StreamSource>>()
  private readonly prepared = new Map<string, TimelineRenderAsset>()
  constructor(
    private readonly plan: TimelineRenderPlan,
    private readonly io: TimelineRenderIO,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener('abort', this.dispose, { once: true })
  }
  asset(clip: TimelineClip): TimelineRenderAsset {
    const source = clip.source
    const asset = this.plan.assets.find(
      candidate => candidate.node === source?.node && candidate.version === source.version,
    )
    if (asset === undefined) throw new TimelineRenderFailure('source', `Missing pinned source for ${clip.id}`)
    return asset
  }
  async get(clip: TimelineClip): Promise<MediaHandle> {
    this.signal.throwIfAborted()
    const previous = this.media.get(clip.id)
    if (previous !== undefined) {
      this.media.delete(clip.id)
      this.media.set(clip.id, previous)
      return previous
    }
    while (this.media.size >= this.plan.maxActiveSources) {
      const oldest = this.media.entries().next().value
      if (oldest === undefined) break
      oldest[1].dispose()
      this.media.delete(oldest[0])
    }
    const asset = this.asset(clip)
    let handle: MediaHandle
    if (asset.kind === 'image') {
      const image = await createImageBitmap(
        new Blob([await smallFile(asset.path, asset.size, this.plan, this.io, this.signal)]),
      )
      if (image.width * image.height > this.plan.maxSourcePixels || this.signal.aborted) {
        image.close()
        this.signal.throwIfAborted()
        throw new TimelineRenderFailure('source', 'Image exceeds the configured pixel limit')
      }
      handle = {
        image,
        input: undefined,
        video: undefined,
        audio: undefined,
        rate: 0,
        duration: Infinity,
        dispose: () => { image.close() },
      }
    } else {
      handle = await this.open(asset, true)
    }
    if (this.signal.aborted) {
      handle.dispose()
      this.signal.throwIfAborted()
    }
    this.media.set(clip.id, handle)
    return handle
  }
  private async open(original: TimelineRenderAsset, allowCompatibility: boolean): Promise<MediaHandle> {
    const identity = `${original.node}/${original.version}`,
      asset = this.prepared.get(identity) ?? original
    const input = inputOf(asset.path, asset.size, this.plan, this.io, this.signal)
    this.opening.add(input)
    try {
      const video = asset.kind === 'video' ? await input.getPrimaryVideoTrack() : null
      const audio = await input.getPrimaryAudioTrack()
      const channels = audio === null ? 0 : await audio.getNumberOfChannels()
      if (asset.kind === 'video' && video === null)
        throw new TimelineRenderFailure('source', 'Video source has no video track')
      if (asset.kind === 'audio' && audio === null)
        throw new TimelineRenderFailure('source', 'Audio source has no audio track')
      if (
        (video !== null && !(await video.canDecode())) ||
        (audio !== null && (!(await audio.canDecode()) || channels > 2))
      ) {
        input.dispose()
        this.opening.delete(input)
        if (!allowCompatibility)
          throw new TimelineRenderFailure('source', 'The local renderer cannot decode the compatibility copy')
        const compatible = await this.io.compatible(original)
        this.prepared.set(identity, compatible)
        return await this.open(original, false)
      }
      if (
        video !== null &&
        (await video.getDisplayWidth()) * (await video.getDisplayHeight()) > this.plan.maxSourcePixels
      )
        throw new TimelineRenderFailure('source', 'Video source exceeds the configured pixel limit')
      this.signal.throwIfAborted()
      return {
        input,
        image: undefined,
        video: video === null ? undefined : new CanvasSink(video, { poolSize: 1 }),
        audio: audio === null ? undefined : new AudioSampleSink(audio),
        rate: audio === null ? 0 : await audio.getSampleRate(),
        duration: video === null ? Infinity : await video.computeDuration(),
        dispose: () => { input.dispose() },
      }
    } catch (error: unknown) {
      input.dispose()
      throw error
    } finally {
      this.opening.delete(input)
    }
  }
  async frame(clip: TimelineClip, sourceMs: number): Promise<TimelineFrame<CanvasImageSource>> {
    const source = await this.get(clip)
    if (source.image !== undefined)
      return { image: source.image, width: source.image.width, height: source.image.height }
    const frame =
      source.video === undefined || sourceMs / 1000 >= source.duration
        ? null
        : await source.video.getCanvas(sourceMs / 1000)
    this.signal.throwIfAborted()
    if (frame === null) throw new TimelineFrameError(clip.id)
    return { image: frame.canvas, width: frame.canvas.width, height: frame.canvas.height }
  }
  dispose = (): void => {
    this.signal.removeEventListener('abort', this.dispose)
    for (const media of this.media.values()) media.dispose()
    for (const input of this.opening) input.dispose()
    this.media.clear()
    this.opening.clear()
  }
}

interface AudioWindow {
  readonly offset: number
  readonly rate: number
  readonly left: Float32Array
  readonly right: Float32Array
}

async function decodeAudioWindow(
  pool: MediaPool,
  clip: TimelineClip,
  fromMs: number,
  toMs: number,
  signal: AbortSignal,
): Promise<AudioWindow | undefined> {
  if (pool.asset(clip).kind === 'image' || clip.source === undefined) return undefined
  const handle = await pool.get(clip)
  if (handle.audio === undefined) return undefined
  const from = (clip.source.inMs + fromMs - clip.startMs) / 1000,
    to = (clip.source.inMs + toMs - clip.startMs) / 1000
  const offset = Math.max(0, Math.floor(from * handle.rate) - 1),
    end = Math.ceil(to * handle.rate) + 2
  const left = new Float32Array(end - offset),
    right = new Float32Array(end - offset)
  for await (const sample of handle.audio.samples(Math.max(0, (offset - 1) / handle.rate), end / handle.rate)) {
    try {
      signal.throwIfAborted()
      if (sample.sampleRate !== handle.rate)
        throw new TimelineRenderFailure('source', 'Audio sample rate changed within a source')
      const base = Math.round(sample.timestamp * sample.sampleRate)
      for (let channel = 0; channel < 2; channel++) {
        const data = new Float32Array(sample.numberOfFrames)
        sample.copyTo(data, { planeIndex: Math.min(channel, sample.numberOfChannels - 1), format: 'f32-planar' })
        const first = Math.max(offset, base),
          last = Math.min(end, base + data.length)
        const output = channel === 0 ? left : right
        if (last > first) output.set(data.subarray(first - base, last - base), first - offset)
      }
    } finally {
      sample.close()
    }
  }
  return { offset, rate: handle.rate, left, right }
}

function interpolated(window: AudioWindow | undefined, sourceMs: number, channel: number): number {
  if (window === undefined) return 0
  const index = (sourceMs * window.rate) / 1000 - window.offset,
    left = Math.floor(index),
    fraction = index - left
  const samples = channel === 0 ? window.left : window.right
  return (samples[left] ?? 0) * (1 - fraction) + (samples[left + 1] ?? 0) * fraction
}

/** Uploads only append writes, preserving muxer/encoder backpressure across the Remote boundary. */
function outputOf(
  plan: TimelineRenderPlan,
  io: TimelineRenderIO,
  part: TimelineRenderPart,
  signal: AbortSignal,
): Output<Mp4OutputFormat, StreamTarget> {
  let offset = 0
  return new Output({
    format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    target: new StreamTarget(
      new WritableStream({
        async write(chunk) {
          signal.throwIfAborted()
          if (chunk.position !== offset)
            throw new TimelineRenderFailure('upload', 'The renderer attempted a non-sequential MP4 write')
          for (let at = 0; at < chunk.data.byteLength; at += plan.maxChunkBytes) {
            const bytes = chunk.data.subarray(at, Math.min(chunk.data.byteLength, at + plan.maxChunkBytes))
            offset = await io.append(part, offset, bytes)
          }
        },
      }),
      { chunked: true, chunkSize: plan.maxChunkBytes },
    ),
  })
}

async function encodeVideo(
  plan: TimelineRenderPlan,
  segment: TimelineRenderBlock,
  pool: MediaPool,
  io: TimelineRenderIO,
  signal: AbortSignal,
): Promise<void> {
  const canvas = new OffscreenCanvas(plan.document.spec.width, plan.document.spec.height),
    context = canvas.getContext('2d')
  if (context === null) throw new TimelineRenderFailure('encoding', 'Canvas 2D rendering is unavailable')
  const part = { kind: 'video', segment: segment.key } as const,
    output = outputOf(plan, io, part, signal)
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: plan.videoBitrate,
    latencyMode: 'realtime',
    keyFrameInterval: 1,
  })
  output.addVideoTrack(source, { frameRate: plan.document.spec.fps })
  let cancellation: Promise<void> | undefined
  const cancel = (): Promise<void> => (cancellation ??= output.cancel())
  const onAbort = (): void => {
    void cancel().catch(io.report)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  let completed = false
  try {
    await output.start()
    for (let frame = segment.fromFrame; frame < segment.toFrame; frame++) {
      signal.throwIfAborted()
      const time = (frame * 1000) / plan.document.spec.fps,
        frames = new Map<TimelineClipId, TimelineFrame<CanvasImageSource>>()
      const visible = timelineFramesAt(plan.document, time)
      if (visible.length > plan.maxActiveSources)
        throw new TimelineRenderFailure('source', 'Timeline exceeds the configured simultaneous source limit')
      for (const input of visible) frames.set(input.clip.id, await pool.frame(input.clip, input.sourceMs))
      paintTimeline(context, plan.document, time, frames, plan.style)
      await source.add((frame - segment.fromFrame) / plan.document.spec.fps, 1 / plan.document.spec.fps, {
        keyFrame: frame === segment.fromFrame,
      })
    }
    source.close()
    await output.finalize()
    completed = true
    await io.complete(part)
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      if (!completed) await cancel()
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }
}

async function encodePcm(
  plan: TimelineRenderPlan,
  segment: TimelineRenderBlock,
  pool: MediaPool,
  io: TimelineRenderIO,
  signal: AbortSignal,
): Promise<void> {
  const start = Math.round((segment.fromFrame * plan.sampleRate) / plan.document.spec.fps),
    end = Math.round((segment.toFrame * plan.sampleRate) / plan.document.spec.fps)
  const part = { kind: 'audio', segment: segment.key } as const
  let offset = 0
  for (let at = start; at < end; at += plan.audioWindowSamples) {
    signal.throwIfAborted()
    const count = Math.min(plan.audioWindowSamples, end - at),
      windows = new Map<TimelineClipId, AudioWindow>()
    const fromMs = (at * 1000) / plan.sampleRate,
      toMs = ((at + count) * 1000) / plan.sampleRate
    for (const track of plan.document.tracks) {
      if (track.muted || track.kind === 'text' || track.volume === 0) continue
      for (const clip of track.clips) {
        if (
          clip.source === undefined ||
          clip.volume === 0 ||
          clip.startMs >= toMs ||
          clip.startMs + clip.durationMs <= fromMs
        )
          continue
        const window = await decodeAudioWindow(
          pool,
          clip,
          Math.max(fromMs, clip.startMs),
          Math.min(toMs, clip.startMs + clip.durationMs),
          signal,
        )
        if (window !== undefined) windows.set(clip.id, window)
        if (windows.size > plan.maxActiveSources)
          throw new TimelineRenderFailure('source', 'Timeline exceeds the configured simultaneous audio source limit')
      }
    }
    const mixed = mixTimelineAudio(
      plan.document,
      at,
      count,
      plan.sampleRate,
      plan.channels,
      (clip, sourceMs, channel) => interpolated(windows.get(clip.id), sourceMs, channel),
    )
    const pcm = new Uint8Array(count * 8),
      view = new DataView(pcm.buffer)
    for (let frame = 0; frame < count; frame++)
      for (let channel = 0; channel < 2; channel++)
        view.setFloat32((frame * 2 + channel) * 4, mixed[channel]?.[frame] ?? 0, true)
    for (let from = 0; from < pcm.byteLength; from += plan.maxChunkBytes)
      offset = await io.append(part, offset, pcm.subarray(from, Math.min(pcm.byteLength, from + plan.maxChunkBytes)))
  }
  await io.complete(part)
}

function sameConfig(left: VideoDecoderConfig, right: VideoDecoderConfig): boolean {
  if (left.codec !== right.codec || left.codedWidth !== right.codedWidth || left.codedHeight !== right.codedHeight)
    return false
  const bytes = (value: AllowSharedBufferSource | undefined): Uint8Array =>
    value === undefined
      ? new Uint8Array()
      : ArrayBuffer.isView(value)
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new Uint8Array(value)
  const a = bytes(left.description),
    b = bytes(right.description)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

async function assemble(
  plan: TimelineRenderWork['plan'],
  io: TimelineRenderIO,
  signal: AbortSignal,
  progress: (value: number) => void,
  beforePublish: () => Promise<void>,
): Promise<void> {
  const part = { kind: 'output' } as const,
    output = outputOf(plan, io, part, signal)
  const video = new EncodedVideoPacketSource('avc'),
    audio = new AudioSampleSource({ codec: 'aac', bitrate: plan.audioBitrate })
  output.addVideoTrack(video, { frameRate: plan.document.spec.fps })
  output.addAudioTrack(audio)
  let cancellation: Promise<void> | undefined
  const cancel = (): Promise<void> => (cancellation ??= output.cancel())
  const onAbort = (): void => {
    void cancel().catch(io.report)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  let completed = false,
    config: VideoDecoderConfig | undefined,
    sequenceNumber = 0
  try {
    await output.start()
    for (const [index, segment] of plan.segments.entries()) {
      signal.throwIfAborted()
      const input = inputOf(segment.videoPath, undefined, plan, io, signal)
      try {
        const track = await input.getPrimaryVideoTrack(),
          current = await track?.getDecoderConfig()
        if (track === null || current === undefined || current === null)
          throw new TimelineRenderFailure('storage', 'Cached video has no decoder configuration')
        if (config !== undefined && !sameConfig(config, current))
          throw new TimelineRenderFailure(
            'encoding',
            'Cached blocks use different encoders; clear this timeline cache and render again',
          )
        config = current
        for await (const packet of new EncodedPacketSink(track).packets()) {
          signal.throwIfAborted()
          await video.add(
            packet.clone({
              timestamp: packet.timestamp + segment.fromFrame / plan.document.spec.fps,
              sequenceNumber: sequenceNumber++,
            }),
            { decoderConfig: config },
          )
        }
      } finally {
        input.dispose()
      }
      const first = Math.round((segment.fromFrame * plan.sampleRate) / plan.document.spec.fps),
        last = Math.round((segment.toFrame * plan.sampleRate) / plan.document.spec.fps)
      const maxSamples = Math.min(plan.audioWindowSamples, Math.floor(plan.maxChunkBytes / 8))
      for (let at = first; at < last; at += maxSamples) {
        signal.throwIfAborted()
        const count = Math.min(maxSamples, last - at),
          bytes = await io.read(segment.audioPath, (at - first) * 8, count * 8, signal)
        if (bytes.byteLength !== count * 8) throw new TimelineRenderFailure('storage', 'Cached PCM block is incomplete')
        const values = new Float32Array(count * 2),
          view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(i * 4, true)
        const sample = new AudioSample({
          data: values,
          format: 'f32',
          sampleRate: plan.sampleRate,
          numberOfChannels: 2,
          timestamp: at / plan.sampleRate,
        })
        try {
          await audio.add(sample)
        } finally {
          sample.close()
        }
      }
      progress(0.8 + (0.19 * (index + 1)) / plan.segments.length)
    }
    video.close()
    audio.close()
    await output.finalize()
    completed = true
    await beforePublish()
    await io.complete(part)
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!completed) await cancel()
  }
}

/**
 * Execute leased local work, retaining at most finite audio windows, active sources and one muxing block.
 * @param work - Host-issued render work bound to a job and lease.
 * @param io - Injected file, compatibility, upload, and progress ports.
 * @param callerSignal - Cancels this worker attempt without publishing incomplete output.
 */
export async function renderTimeline(
  work: TimelineRenderWork,
  io: TimelineRenderIO,
  callerSignal: AbortSignal,
): Promise<void> {
  const heartbeatAbort = new AbortController(),
    signal = AbortSignal.any([callerSignal, heartbeatAbort.signal])
  const plan = work.plan,
    pool = new MediaPool(plan, io, signal)
  let font: FontFace | undefined,
    fraction = 0,
    assembling = false,
    heartbeat: Promise<void> | undefined,
    heartbeatError: Error | undefined
  const report = (): void => {
    if (heartbeat !== undefined) return
    heartbeat = io
      .progress(fraction, assembling)
      .catch((error: unknown) => {
        heartbeatError = error instanceof Error ? error : new Error('Render progress failed', { cause: error })
        heartbeatAbort.abort(heartbeatError)
      })
      .finally(() => {
        heartbeat = undefined
      })
  }
  const timer = setInterval(report, plan.heartbeatMs)
  try {
    if (plan.font !== undefined) {
      font = new FontFace(plan.style.fontFamily, await smallFile(plan.font.path, plan.font.size, plan, io, signal))
      await font.load()
      signal.throwIfAborted()
      document.fonts.add(font)
    }
    for (const [index, segment] of plan.segments.entries()) {
      signal.throwIfAborted()
      if (heartbeatError !== undefined) throw heartbeatError
      if (!segment.cached) {
        await encodeVideo(plan, segment, pool, io, signal)
        await encodePcm(plan, segment, pool, io, signal)
      }
      fraction = (0.8 * (index + 1)) / plan.segments.length
      report()
    }
    pool.dispose()
    assembling = true
    await io.progress(fraction, assembling)
    await assemble(
      plan,
      io,
      signal,
      (value) => {
        fraction = value
        report()
      },
      async () => {
        clearInterval(timer)
        if (heartbeat !== undefined) await heartbeat
        signal.throwIfAborted()
      },
    )
  } finally {
    clearInterval(timer)
    pool.dispose()
    if (font !== undefined) document.fonts.delete(font)
    if (heartbeat !== undefined) await heartbeat
  }
}
