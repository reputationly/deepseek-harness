/** Resolve immutable inputs and content-addressed, frame-aligned composition blocks. */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CanvasService } from '@deepseek-ai/dsh-canvas'
import { CanvasConflictError, CanvasInputError } from '@deepseek-ai/dsh-canvas'
import { timelineDuration } from '@deepseek-ai/dsh-canvas'
import type { CanvasNodeId, EpisodeId, Timeline } from '@deepseek-ai/dsh-canvas/client'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TimelineCacheKey, TimelineRenderAsset, TimelineRenderPlan } from './timeline-render-types.ts'
import type { TimelineCompatibilityRecipe } from './timeline-compatibility.ts'

/** Deployment limits and encoding preferences resolved by the owning plugin. */
export interface TimelineRenderConfig {
  readonly chunkFrames: number
  readonly maxChunkBytes: number
  readonly leaseTimeoutMs: number
  readonly maxActiveSources: number
  readonly videoBitsPerPixel: number
  readonly audioBitrate: number
  readonly fontFamily: string
  readonly fontFile?: string
  readonly compatibility: TimelineCompatibilityRecipe
  readonly sourceCacheBytes: number
  readonly maxImageBytes: number
  readonly maxSourcePixels: number
  readonly audioWindowSamples: number
  readonly heartbeatMs: number
}

function hash(value: unknown): TimelineCacheKey {
  return brandString<TimelineCacheKey>(createHash('sha256').update(JSON.stringify(value)).digest('hex'))
}

/**
 * Resolve sources from pinned versions, never from a node's current active version.
 * @param canvas - Canvas containing the pinned media sources.
 * @param session - Session that owns the project and render task.
 * @param node - Canvas node whose timeline or pinned asset is addressed.
 * @param revision - Reviewed timeline revision that must still be current.
 * @param config - Validated render limits and output settings.
 * @param episode - Explicit episode; omission uses the Session binding.
 * @param expectedDirectory - Captured project directory used to reject a project switch.
 * @returns The fenced project location and resolved render plan.
 */
export async function resolveTimelinePlan(
  canvas: CanvasService,
  session: Session,
  node: CanvasNodeId,
  revision: number,
  config: TimelineRenderConfig,
  episode?: EpisodeId,
  expectedDirectory?: string,
): Promise<{ readonly directory: string; readonly file: string; readonly plan: TimelineRenderPlan }> {
  const target = await canvas.targetOf(session, episode, expectedDirectory)
  const document = await canvas.timeline(session, node, target.episode.id, target.directory)
  if (document === undefined) throw new CanvasInputError('initialize the timeline before rendering')
  if (document.spec.width * document.spec.height > config.maxSourcePixels)
    throw new CanvasInputError('timeline output exceeds the configured pixel limit')
  if (document.revision !== revision) throw new CanvasConflictError(revision, document.revision)
  const frames = Math.ceil((timelineDuration(document) * document.spec.fps) / 1000)
  if (frames === 0) throw new CanvasInputError('add a clip before rendering')
  const source = await canvas.read(session, target.episode.id, target.directory)
  const assets: TimelineRenderAsset[] = []
  for (const track of document.tracks)
    for (const clip of track.clips) {
      if (clip.source === undefined || track.muted) continue
      if (assets.some(asset => asset.node === clip.source?.node && asset.version === clip.source.version)) continue
      const input = source.nodes.find(candidate => candidate.id === clip.source?.node)
      const version = input?.versions?.find(candidate => candidate.id === clip.source?.version)
      if (
        input === undefined ||
        version?.path === undefined ||
        (input.type !== 'image' && input.type !== 'video' && input.type !== 'audio')
      ) {
        throw new CanvasInputError(`clip ${clip.id} source version is unavailable`)
      }
      const path = resolve(target.directory, version.path)
      const info = await stat(path)
      if (!info.isFile()) throw new CanvasInputError(`clip ${clip.id} source is not a file`)
      assets.push({
        node: input.id,
        version: version.id,
        kind: input.type,
        path,
        size: info.size,
        modifiedMs: info.mtimeMs,
      })
    }
  const fontPath = config.fontFile
  const font =
    fontPath === undefined
      ? undefined
      : await stat(fontPath).then((info) => {
        if (!info.isFile()) throw new CanvasInputError('the configured timeline font is not a file')
        return { path: fontPath, size: info.size, modifiedMs: info.mtimeMs }
      })
  // Defaults are output styling, not the editor theme. A configured font is loaded under one explicit family.
  const style = {
    background: '#000000',
    fontFamily: font === undefined ? config.fontFamily : 'DshTimeline',
    textColor: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: document.spec.width / 240,
    textMargin: document.spec.width * 0.06,
    lineHeight: 1.25,
  }
  const encoding = {
    sampleRate: 48000 as const,
    channels: 2 as const,
    videoBitrate: Math.round(document.spec.width * document.spec.height * document.spec.fps * config.videoBitsPerPixel),
    audioBitrate: config.audioBitrate,
  }
  const segments = []
  for (let fromFrame = 0; fromFrame < frames; fromFrame += config.chunkFrames) {
    const toFrame = Math.min(frames, fromFrame + config.chunkFrames)
    const fromMs = (fromFrame * 1000) / document.spec.fps,
      toMs = (toFrame * 1000) / document.spec.fps
    const tracks = document.tracks
      .filter(track => !track.muted)
      .map(track => ({
        ...track,
        clips: track.clips.filter(clip => clip.startMs < toMs && clip.startMs + clip.durationMs > fromMs),
      }))
      .filter(track => track.clips.length !== 0)
    for (const boundary of tracks.flatMap(track =>
      track.clips.flatMap(clip => [clip.startMs, clip.startMs + clip.durationMs]),
    )) {
      const active = tracks
        .flatMap(track => track.clips)
        .filter(
          clip => clip.source !== undefined && clip.startMs <= boundary && boundary < clip.startMs + clip.durationMs,
        ).length
      if (active > config.maxActiveSources)
        throw new CanvasInputError(`timeline exceeds the ${String(config.maxActiveSources)} simultaneous source limit`)
    }
    const dependencies = assets.filter(asset =>
      tracks.some(track =>
        track.clips.some(clip => clip.source?.node === asset.node && clip.source.version === asset.version),
      ),
    )
    segments.push({
      key: hash({
        version: 1,
        fromFrame,
        toFrame,
        spec: document.spec,
        style,
        font,
        encoding,
        compatibility: config.compatibility,
        tracks,
        dependencies,
      }),
      fromFrame,
      toFrame,
    })
  }
  const key = hash({ version: 1, revision, spec: document.spec, segments, assets, font, style, encoding })
  // Fence reads that raced a user edit while resolving inputs. Never silently render a later revision.
  const latest = await canvas.timeline(session, node, target.episode.id)
  if (latest?.revision !== revision) throw new CanvasConflictError(revision, latest?.revision ?? 0)
  return {
    directory: target.directory,
    file: target.file,
    plan: {
      version: 1,
      key,
      node,
      episode: target.episode.id,
      document,
      assets,
      style,
      ...(font === undefined ? {} : { font }),
      frames,
      ...encoding,
      maxChunkBytes: config.maxChunkBytes,
      maxActiveSources: config.maxActiveSources,
      sourceCacheBytes: config.sourceCacheBytes,
      maxImageBytes: config.maxImageBytes,
      maxSourcePixels: config.maxSourcePixels,
      audioWindowSamples: config.audioWindowSamples,
      heartbeatMs: config.heartbeatMs,
      segments,
    },
  }
}

/**
 * Verify that the files pinned by a render plan still match their captured metadata.
 * @returns whether every input still has the identity captured by this plan.
 * @param plan - Resolved plan containing captured source metadata.
 */
export async function timelineInputsUnchanged(plan: TimelineRenderPlan): Promise<boolean> {
  for (const asset of [...plan.assets, ...(plan.font === undefined ? [] : [plan.font])]) {
    const current = await stat(asset.path).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (current === undefined || current.size !== asset.size || current.mtimeMs !== asset.modifiedMs) return false
  }
  return true
}

/**
 * The exact interleaved Float32 stereo sample count in one frame-aligned block.
 * @param document - Validated timeline before the edit or sample calculation.
 * @param fromFrame - Inclusive first frame of the segment.
 * @param toFrame - Exclusive frame after the segment.
 * @returns The sample offset and count covering the frame interval.
 */
export function timelineSegmentSamples(
  document: Timeline,
  fromFrame: number,
  toFrame: number,
): { readonly start: number; readonly count: number } {
  const start = Math.round((fromFrame * 48000) / document.spec.fps)
  return { start, count: Math.round((toFrame * 48000) / document.spec.fps) - start }
}
