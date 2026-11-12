/**
 * Project and episode files: one project directory owns one `project.json`, which names the canvas
 * file of every episode and the episode each Session is bound to.
 * @module
 */

import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { EpisodeId } from './types.ts'

/** Format of the production a project holds. */
export type ProductionFormat = 'drama' | 'comic' | 'mv' | 'free'

/** Output specification shared by every episode of a project. */
export interface ProjectSpec {
  readonly aspect: '16:9' | '9:16' | '1:1' | '4:3' | '3:4'
  readonly resolution: string
  readonly fps: 24 | 25 | 30
}

/** One episode of a project. */
export interface Episode {
  readonly id: EpisodeId
  readonly title: string
  /** Canvas file path relative to `.canvas/`. */
  readonly file: string
}

/** `.canvas/project.json`. */
export interface StudioProject {
  readonly version: 1
  /** Incremented by every successful write. */
  readonly revision: number
  readonly format: ProductionFormat
  readonly title: string
  readonly spec: ProjectSpec
  readonly episodes: readonly Episode[]
  /** Session id to the episode that Session edits. */
  readonly bindings: Readonly<Record<string, EpisodeId>>
}

/** The project a directory that never created one behaves as. */
export const FREE_PROJECT: StudioProject = {
  version: 1,
  revision: 0,
  format: 'free',
  title: 'Canvas',
  spec: { aspect: '16:9', resolution: '1080p', fps: 30 },
  episodes: [],
  bindings: {},
}

const FORMATS: readonly ProductionFormat[] = ['drama', 'comic', 'mv', 'free']
const ASPECTS: readonly ProjectSpec['aspect'][] = ['16:9', '9:16', '1:1', '4:3', '3:4']

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`project.json: ${what} is not an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`project.json: ${what} is not a string`)
  return value
}

/**
 * Parse a project file.
 * @param source - file content.
 * @returns the validated project.
 * @throws Error naming the field that is not a project.
 */
export function parseProject(source: string): StudioProject {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error: unknown) {
    throw new Error(`project.json: ${String(error)}`)
  }
  const raw = record(value, 'document')
  if (raw.version !== 1) throw new Error(`project.json: unsupported version ${JSON.stringify(raw.version)}`)
  const revision = raw.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) throw new Error('project.json: revision is not a non-negative integer')
  const format = text(raw.format, 'format')
  if (!(FORMATS as readonly string[]).includes(format)) throw new Error(`project.json: unknown format ${format}`)
  const spec = record(raw.spec, 'spec')
  const aspect = text(spec.aspect, 'spec.aspect')
  if (!(ASPECTS as readonly string[]).includes(aspect)) throw new Error(`project.json: unknown aspect ${aspect}`)
  const fps = spec.fps
  if (fps !== 24 && fps !== 25 && fps !== 30) throw new Error('project.json: spec.fps is not 24, 25, or 30')
  const episodes = Array.isArray(raw.episodes) ? raw.episodes.map((entry, index) => parseEpisode(entry, index)) : null
  if (episodes === null) throw new Error('project.json: episodes is not an array')
  const bindings = record(raw.bindings ?? {}, 'bindings')
  for (const [session, episode] of Object.entries(bindings)) {
    if (!episodes.some(entry => entry.id === episode)) throw new Error(`project.json: binding ${session} names missing episode ${String(episode)}`)
  }
  return {
    version: 1,
    revision,
    format: format as ProductionFormat,
    title: text(raw.title, 'title'),
    spec: { aspect: aspect as ProjectSpec['aspect'], resolution: text(spec.resolution, 'spec.resolution'), fps: fps as 24 | 25 | 30 },
    episodes,
    bindings: Object.fromEntries(Object.entries(bindings).map(([session, episode]) => [session, brandString<EpisodeId>(text(episode, `bindings.${session}`))])),
  }
}

function parseEpisode(value: unknown, index: number): Episode {
  const raw = record(value, `episodes[${String(index)}]`)
  return {
    id: brandString<EpisodeId>(text(raw.id, `episodes[${String(index)}].id`)),
    title: text(raw.title, `episodes[${String(index)}].title`),
    file: text(raw.file, `episodes[${String(index)}].file`),
  }
}

/**
 * Serialize a project file.
 * @param project - validated project.
 * @returns pretty-printed JSON ending in a newline.
 */
export function serializeProject(project: StudioProject): string {
  return `${JSON.stringify(project, null, 2)}\n`
}

/**
 * Absolute canvas file of one episode.
 * @param directory - project directory.
 * @param project - project that names the episode files.
 * @param episode - episode to resolve; a project without episodes resolves to the single canvas.
 * @returns absolute path under `.canvas/`.
 */
export function canvasFileOf(directory: string, project: StudioProject, episode?: EpisodeId): string {
  const held = episode === undefined
    ? project.episodes[0]
    : project.episodes.find(entry => entry.id === episode)
  return join(directory, '.canvas', held?.file ?? 'canvas.json')
}

/**
 * Episode a Session edits: its binding, else the first episode.
 * @param project - project that holds the bindings.
 * @param sessionId - Session asking.
 * @returns the episode id.
 * @throws Error when the project has no episode to edit.
 */
export function episodeOf(project: StudioProject, sessionId: string): EpisodeId {
  const bound = project.bindings[sessionId]
  if (bound !== undefined) return bound
  const [first] = project.episodes
  if (first === undefined) throw new Error('project.json: the project has no episode')
  return first.id
}

/**
 * Add an episode to a project.
 * @param project - current project.
 * @param title - episode title.
 * @returns the project with the episode appended and the new episode id.
 */
export function withEpisode(project: StudioProject, title: string): { readonly project: StudioProject; readonly episode: Episode } {
  const highest = project.episodes.reduce((top, entry) => Math.max(top, Number(entry.id.slice(1)) || 0), 0)
  const episode: Episode = {
    id: brandString<EpisodeId>(`e${String(highest + 1)}`),
    title,
    file: project.episodes.length === 0 ? 'canvas.json' : `episodes/e${String(highest + 1)}.json`,
  }
  return { project: { ...project, episodes: [...project.episodes, episode] }, episode }
}

/**
 * Bind a Session to an episode.
 * @param project - current project.
 * @param sessionId - Session being bound.
 * @param episode - episode it edits.
 * @returns the project with the binding replaced.
 * @throws Error when the episode does not exist.
 */
export function withBinding(project: StudioProject, sessionId: string, episode: EpisodeId): StudioProject {
  if (!project.episodes.some(entry => entry.id === episode)) throw new Error(`project.json: episode ${episode} does not exist`)
  return { ...project, bindings: { ...project.bindings, [sessionId]: episode } }
}
