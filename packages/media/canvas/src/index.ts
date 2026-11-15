/**
 * Project canvas: one document per episode, edited by the model through `canvas_get` and
 * `canvas_edit`, by users through the `canvas` Remote namespace, and read by media tools for inputs.
 * @module @deepseek-ai/dsh-canvas
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-working-directory'
import { bibleFile, EMPTY_BIBLE, parseBible, type Bible, type BibleEntry } from './bible.ts'
import type z from '@deepseek-ai/schemastery'
import { Config as configSchema, resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { activeVersionOf, assertWithinLimits, CanvasCorruptError, CanvasUnsupportedVersionError } from './document.ts'
import { applyOperations, CanvasConflictError, checkRevision } from './operations.ts'
import {
  episodeOf,
  parseProject,
  withBinding,
  withEpisode,
  type ProjectSpec,
  type ProductionFormat,
  type StudioProject,
} from './project.ts'
import { advanceStage, EMPTY_PRODUCTION, parseProductionFile, stageOf } from './production.ts'
import { planShotSegments } from './segments.ts'
import { canvasFile, CanvasStore } from './store.ts'
import { registerCanvasTools } from './tools.ts'
import { registerTimelineTools } from './timeline-tools.ts'
import { applyTimeline, parseTimeline, timelineDuration } from './timeline.ts'
import type {
  Timeline,
  TimelineEditResult,
  TimelineOperation,
  TimelineRevision,
  TimelineRestoreMode,
} from './timeline-types.ts'
import type {
  BibleEntryId,
  CanvasDocument,
  CanvasEditResult,
  CanvasEpisode,
  CanvasNode,
  CanvasOperation,
  CanvasView,
  EpisodeId,
  GateId,
  Production,
  StageId,
  CanvasNodeId,
  VersionId,
  CanvasEditorContext,
} from './types.ts'

export type * from './types.ts'
export type * from './timeline-types.ts'
export { applyTimeline, parseTimeline, timelineDuration } from './timeline.ts'
export { activeVersionOf, parseCanvas, CanvasCorruptError, CanvasUnsupportedVersionError } from './document.ts'
export { previewVersionOf } from './versions.ts'
export { CanvasConflictError } from './operations.ts'
export { Config } from './config.ts'
export type { StudioProject, ProjectSpec, ProductionFormat } from './project.ts'
export { gateBibleFirst, gateStoryboardQuality, STAGE_ORDER, videoNodesByShots } from './production.ts'
export { planShotSegments, shotSegmentKind } from './segments.ts'
export type { Bible, BibleEntry } from './bible.ts'

/** Keep alternate names unique within one entry; cross-entry collisions remain validation errors. */
function normalizeBibleAliases(entry: BibleEntry): BibleEntry {
  const names = new Set([entry.name.toLowerCase()])
  const aliases = entry.aliases.filter((alias) => {
    const name = alias.toLowerCase()
    if (names.has(name)) return false
    names.add(name)
    return true
  })
  return { ...entry, aliases }
}

/**
 * Generation segments of every storyboard in one document.
 * @param document - canvas document.
 * @param maxSegmentSeconds - longest segment one generation call may cover.
 * @returns segments keyed by storyboard node id.
 */
function storyboardSegments(
  document: CanvasDocument,
  maxSegmentSeconds: number,
): Readonly<Record<string, readonly import('./types.ts').StoryboardSegment[]>> {
  const segments: Record<string, readonly import('./types.ts').StoryboardSegment[]> = {}
  for (const node of document.nodes) {
    if (node.type !== 'storyboard') continue
    const shots = (node.versions ?? []).find(version => version.id === node.activeVersion)?.shots ?? []
    segments[node.id] = planShotSegments(shots, { maxSegmentSec: maxSegmentSeconds }).segments
  }
  return segments
}

/** Project metadata file relative to `.canvas/`. */
const PROJECT_FILE = 'project.json'

/** Production record file relative to `.canvas/`. */
const PRODUCTION_FILE = 'production.json'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Project canvas documents and the `canvas` Remote namespace. */
    canvas: CanvasService
  }
  interface Events {
    /**
     * A Client opens an episode; providers reconcile durable work before its first view.
     * @mode parallel
     * @param session - Session that opened the project.
     * @param episode - episode to reconcile.
     */
    'canvas/open'(session: Session, episode: EpisodeId): Promise<void>
  }
}

/** Raised when a node or group cannot serve as a generation input. */
export class CanvasInputError extends Error {
  /** @param message - which reference failed and why. */
  constructor(message: string) {
    super(message)
    this.name = 'CanvasInputError'
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false
    throw error
  }
}

/** Where one Session's edits land. */
export interface CanvasTarget {
  readonly directory: string
  readonly project: StudioProject | undefined
  readonly episode: CanvasEpisode
  /** Episode canvas file relative to `.canvas/`. */
  readonly file: string
}

/** Bible entries one project's storyboards reference. */
export interface BibleReferences {
  readonly entries: ReadonlyMap<BibleEntryId, readonly string[]>
}

/** Owns every project's canvas documents. */
export class CanvasService extends TypertRemoteService {
  static inject = ['tools', 'workingDirectory', 'systemPrompt']

  static Config: z<Config> = configSchema

  private readonly store: CanvasStore
  private readonly limits: ResolvedConfig
  private readonly editors = new WeakMap<Session, CanvasEditorContext>()

  /**
   * @param ctx - Host context carrying the tool registry and Session directories.
   * @param config - deployment bounds for canvas documents.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'canvas')
    this.limits = resolveConfig(config)
    this.store = new CanvasStore(this.limits)
    registerCanvasTools(ctx, this)
    registerTimelineTools(ctx, this)
    ctx.systemPrompt.context({
      name: 'canvas:editor',
      order: ctx.systemPrompt.getContextOrder('CANVAS_EDITOR'),
      interpolate: false,
      text: ({ agent }) => {
        if (agent === undefined) return ''
        const editor = this.editors.get(agent.session)
        if (editor === undefined || editor.scope.directory !== this.directoryOf(agent.session)) return ''
        return (
          'Last reported canvas editor (UI selection only; saved project data remains authoritative):\n' +
          JSON.stringify(editor) +
          '\nRead canvas_get and, for timeline edits, timeline_get before acting. ' +
          'The selected version may be an unadopted candidate or missing. Preserve unsaved user drafts; do not treat them as saved edits. ' +
          'Unavailable editor state must not redirect work to another project or episode.'
        )
      },
    })
  }

  /**
   * Publish or clear one Session's editor hint for the next logged runtime-context snapshot.
   * @param session - Session owning this UI selection.
   * @param context - captured selection without draft values; omitted when the editor closes.
   * @throws RemoteError when the reported project no longer belongs to this Session; its old hint is cleared.
   */
  @Remote('editorContext')
  editorContext(session: Session, context?: CanvasEditorContext): void {
    this.editors.delete(session)
    if (context === undefined) return
    if (context.scope.directory !== this.directoryOf(session)) {
      const error = new CanvasInputError('The project changed; reopen the editor before sharing its selection')
      throw new RemoteError('canvas/invalid-input', error.message, { reason: error.message }, { cause: error })
    }
    this.editors.set(session, context)
  }

  /**
   * Project directory whose canvas a Session edits.
   * @param session - Session opened on the project.
   * @returns the Session's original directory, or its current one when the header records none.
   */
  directoryOf(session: Session): string {
    return session.header.cwd ?? this.ctx.workingDirectory.get(session)
  }

  /**
   * Project, episode, and files one Session edits.
   * @param session - Session opened on the project.
   * @param episode - episode the caller asked for; the Session's binding applies when omitted.
   * @returns the resolved target; a directory without `project.json` reports the single canvas.
   * @throws Error when the requested episode does not exist.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   */
  async targetOf(session: Session, episode?: EpisodeId, expectedDirectory?: string): Promise<CanvasTarget> {
    const directory = this.directoryOf(session)
    if (expectedDirectory !== undefined && expectedDirectory !== directory)
      throw new CanvasInputError('the project changed; reopen the canvas before editing')
    const project = await this.readProject(session)
    if (project === undefined) {
      if (episode !== undefined && episode !== 'e1')
        throw new CanvasInputError(`canvas episode ${episode} does not exist`)
      return {
        directory,
        project: undefined,
        episode: { id: brandString<EpisodeId>('e1'), title: 'Canvas' },
        file: 'canvas.json',
      }
    }
    const chosen = episode ?? episodeOf(project, session.id)
    const held = project.episodes.find(entry => entry.id === chosen)
    if (held === undefined) throw new Error(`canvas: episode ${chosen} does not exist`)
    return { directory, project, episode: { id: held.id, title: held.title }, file: held.file }
  }

  /**
   * Read the canvas of a Session's project.
   * @param session - Session opened on the project.
   * @param episode - episode to read; the Session's binding applies when omitted.
   * @returns the validated document; an empty canvas when the project has none.
   * @throws `CanvasCorruptError` when the canvas file is not a valid document.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   */
  async read(session: Session, episode?: EpisodeId, expectedDirectory?: string): Promise<CanvasDocument> {
    const target = await this.targetOf(session, episode, expectedDirectory)
    return this.store.readCanvas(target.directory, target.file)
  }

  /**
   * Apply operations to the canvas of a Session's project in one write.
   * @param session - Session opened on the project.
   * @param operations - ordered operations; relative media paths resolve against the project directory.
   * @param options - base revision, captured target, origin, and atomic mode to reject the whole batch when any operation is skipped.
   * @returns assigned ids, the revision after the write, and the skipped operations with their reasons.
   * @throws `CanvasCorruptError` when the canvas file is not a valid document.
   * @throws `CanvasConflictError` when the document moved past the caller's base revision.
   */
  async edit(
    session: Session,
    operations: readonly CanvasOperation[],
    options: {
      readonly baseRevision?: number
      readonly episode?: EpisodeId
      readonly origin?: 'agent' | 'user'
      readonly expectedDirectory?: string
      readonly atomic?: boolean
      readonly timelineRevisions?: readonly { readonly node: CanvasNodeId; readonly revision: number }[]
    } = {},
  ): Promise<CanvasEditResult> {
    if (operations.length > this.limits.maxBatchOperations) {
      throw new Error(
        `canvas: ${String(operations.length)} operations exceed the ${String(this.limits.maxBatchOperations)} this deployment accepts`,
      )
    }
    const target = await this.targetOf(session, options.episode, options.expectedDirectory)
    const rejected = new Map<number, string>()
    const prepared = await Promise.all(
      operations.map(async (operation, index) => {
        if ((operation.op !== 'add' && operation.op !== 'update') || operation.path === undefined) return operation
        const path = isAbsolute(operation.path) ? operation.path : resolve(target.directory, operation.path)
        if (!(await isFile(path))) rejected.set(index, `file ${operation.path} does not exist`)
        return { ...operation, path }
      }),
    )
    const notification = { changed: false }
    const result = await this.store.updateCanvas(target.directory, target.file, async (current) => {
      checkRevision(current, options.baseRevision)
      for (const expected of options.timelineRevisions ?? []) {
        const stored = await this.store.readDocument(
          target.directory,
          this.timelineFile(target, expected.node),
          parseTimeline,
        )
        const revision = stored?.value.revision ?? 0
        if (revision !== expected.revision) throw new CanvasConflictError(expected.revision, revision)
      }
      const timelines: { readonly node: CanvasNodeId; readonly document: Timeline }[] = []
      const preservedVersions = new Map<CanvasNodeId, Set<VersionId>>()
      for (const node of current.nodes) {
        if (node.type !== 'timeline') continue
        const saved = await this.store.documentHistory(
          target.directory,
          this.timelineFile(target, node.id),
          parseTimeline,
          this.limits.timelineHistoryLimit,
        )
        for (const document of saved) {
          timelines.push({ node: node.id, document })
          for (const track of document.tracks)
            for (const clip of track.clips) {
              if (clip.source === undefined) continue
              let versions = preservedVersions.get(clip.source.node)
              if (versions === undefined) {
                versions = new Set()
                preservedVersions.set(clip.source.node, versions)
              }
              versions.add(clip.source.version)
            }
        }
      }
      const outcome = applyOperations(current, prepared, {
        limits: this.limits,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        rejected,
        preservedVersions,
      })
      if (options.atomic === true && outcome.result.skipped.length > 0) {
        throw new CanvasInputError(
          `canvas batch rejected: ${outcome.result.skipped.map(item => item.reason).join('; ')}`,
        )
      }
      for (const held of timelines) {
        if (!outcome.document.nodes.some(node => node.id === held.node)) continue
        for (const track of held.document.tracks)
          for (const clip of track.clips) {
            if (clip.source === undefined) continue
            const source = outcome.document.nodes.find(node => node.id === clip.source?.node)
            if (!source?.versions?.some(version => version.id === clip.source?.version)) {
              throw new CanvasInputError(
                `timeline ${held.node} revision ${String(held.document.revision)} retains clip ${clip.id}; remove its live reference and let history expire, or remove the timeline, before deleting its source`,
              )
            }
          }
      }
      assertWithinLimits(outcome.document, this.limits)
      notification.changed = outcome.changed
      return { ...(outcome.changed ? { document: outcome.document } : {}), value: outcome.result }
    })
    if (notification.changed) {
      this.ctx.emit('canvas/change', {
        directory: target.directory,
        episode: target.episode.id,
        revisions: { canvas: result.revision },
      })
    }
    return result
  }

  /**
   * Picture nodes and groups stand for as generation inputs.
   * @param session - Session opened on the project.
   * @param ids - image node ids or group ids; a group stands for its image members in reading order.
   * @returns absolute image paths in input order, without duplicates.
   * @throws {@link CanvasInputError} when an id is unknown, is not an image or group, or is a group without images.
   */
  async resolveImages(session: Session, ids: readonly string[]): Promise<string[]> {
    const document = await this.read(session)
    const paths: string[] = []
    const take = (node: CanvasNode): void => {
      const path = activeVersionOf(node)?.path
      if (path !== undefined && !paths.includes(path)) paths.push(path)
    }
    for (const id of ids) {
      const node = document.nodes.find(candidate => candidate.id === id)
      if (node === undefined) throw new CanvasInputError(`canvas node ${id} does not exist`)
      if (node.type === 'image') {
        take(node)
      } else if (node.type === 'group') {
        const images = document.nodes
          .filter(member => member.group === id && member.type === 'image')
          .sort((a, b) => a.y - b.y || a.x - b.x)
        if (images.length === 0) throw new CanvasInputError(`canvas group ${id} contains no image`)
        images.forEach(take)
      } else {
        throw new CanvasInputError(`canvas node ${id} is a ${node.type} node, not an image or a group`)
      }
    }
    return paths
  }

  /**
   * Resolve image, video, and audio nodes to their local media files.
   * @param session - Session opened on the project.
   * @param ids - media node ids in the order the caller will consume them.
   * @returns absolute media paths in input order.
   * @throws {@link CanvasInputError} when an id is unknown, is not a media node, or has no path.
   */
  async resolveMedia(session: Session, ids: readonly string[]): Promise<string[]> {
    const document = await this.read(session)
    return ids.map((id) => {
      const node = document.nodes.find(candidate => candidate.id === id)
      if (node === undefined) throw new CanvasInputError(`canvas node ${id} does not exist`)
      if (node.type !== 'image' && node.type !== 'video' && node.type !== 'audio') {
        throw new CanvasInputError(`canvas node ${id} is a ${node.type} node, not a media node`)
      }
      const path = activeVersionOf(node)?.path
      if (path === undefined) throw new CanvasInputError(`canvas media node ${id} has no path`)
      return path
    })
  }

  /**
   * Read the project metadata and every episode.
   * @param session - Session opened on the project.
   * @returns the project, its revision, the current episode, and the episodes of the project.
   */
  async projectOf(session: Session): Promise<{
    readonly project: StudioProject | undefined
    readonly revision: number
    readonly current: CanvasEpisode
    readonly episodes: readonly CanvasEpisode[]
  }> {
    const stored = await this.store.readDocument(this.directoryOf(session), PROJECT_FILE, parseProject)
    const target = await this.targetOf(session)
    const episodes = stored?.value.episodes.map(entry => ({ id: entry.id, title: entry.title })) ?? [target.episode]
    return { project: stored?.value, revision: stored?.revision ?? 0, current: target.episode, episodes }
  }

  /**
   * Read the bible of a Session's project.
   * @param session - Session opened on the project.
   * @param expectedDirectory - captured project owner, when called from a running media job.
   * @returns the bible, or an empty one when the project has none, with the revision the file holds.
   */
  async bibleOf(
    session: Session,
    expectedDirectory?: string,
  ): Promise<{ readonly bible: Bible; readonly revision: number }> {
    const directory = this.directoryOf(session)
    if (expectedDirectory !== undefined && directory !== expectedDirectory)
      throw new CanvasInputError('the project changed; reopen the canvas before editing')
    const stored = await this.store.readDocument(directory, bibleFile(), parseBible)
    return stored === undefined
      ? { bible: EMPTY_BIBLE, revision: 0 }
      : { bible: stored.value, revision: stored.revision }
  }

  /**
   * Bible entries the storyboards of every episode of a project reference.
   * @param session - Session opened on the project.
   * @returns the referencing storyboard nodes per entry id.
   */
  async bibleReferences(session: Session): Promise<ReadonlyMap<BibleEntryId, readonly string[]>> {
    const target = await this.targetOf(session)
    const files = target.project === undefined ? [target.file] : target.project.episodes.map(entry => entry.file)
    const references = new Map<BibleEntryId, string[]>()
    for (const file of files) {
      const document = await this.store.readCanvas(target.directory, file)
      for (const node of document.nodes) {
        const shots = node.type === 'storyboard' ? (activeVersionOf(node)?.shots ?? []) : []
        for (const shot of shots) {
          const used = [...shot.characters, ...shot.props, ...(shot.scene === undefined ? [] : [shot.scene])]
          for (const line of shot.dialogue) {
            if (line.speaker.kind === 'character') used.push(line.speaker.entry)
          }
          for (const entry of used) {
            const holders = references.get(entry) ?? []
            if (!holders.includes(node.id)) references.set(entry, [...holders, node.id])
          }
        }
      }
    }
    return references
  }

  /**
   * Read the production record of a Session's project.
   * @param session - Session opened on the project.
   * @returns the production record, an empty one when the project has none, and its revision.
   */
  async productionOf(session: Session): Promise<{ readonly production: Production; readonly revision: number }> {
    const stored = await this.store.readDocument(this.directoryOf(session), PRODUCTION_FILE, parseProductionFile)
    return stored === undefined
      ? { production: EMPTY_PRODUCTION, revision: 0 }
      : { production: stored.value, revision: stored.revision }
  }

  /**
   * Record the stage one episode has reached.
   * @param session - Session opened on the project.
   * @param to - stage to record.
   * @param override - gate to record as overridden, with the reason a user gave.
   * @param baseRevision - production revision the caller read, or undefined to skip the check.
   * @returns the production record after the write, its revision, and the previous stage.
   * @throws `CanvasConflictError` when the production moved past the caller's base revision.
   */
  async setStage(
    session: Session,
    to: StageId,
    override?: { readonly gate: GateId; readonly reason: string },
    baseRevision?: number,
  ): Promise<{ readonly production: Production; readonly revision: number; readonly previous: StageId }> {
    const directory = this.directoryOf(session)
    const target = await this.targetOf(session)
    const previous = stageOf((await this.productionOf(session)).production, target.episode.id)
    const at = new Date().toISOString()
    const written = await this.store.updateDocument(
      directory,
      PRODUCTION_FILE,
      parseProductionFile,
      () => EMPTY_PRODUCTION,
      (current) => {
        if (baseRevision !== undefined && baseRevision !== current.revision)
          throw new CanvasConflictError(baseRevision, current.revision)
        return { document: advanceStage(current, target.episode.id, to, override, at), value: undefined }
      },
    )
    const production = (await this.productionOf(session)).production
    this.ctx.emit('canvas/change', { directory, revisions: { production: written.revision } })
    return { production, revision: written.revision, previous }
  }

  /**
   * Create the project metadata, making the existing single canvas its first episode.
   * @param session - Session opened on the project.
   * @param request - production format, title, and output specification.
   * @returns the project after the write and its revision.
   * @throws Error when the project already has metadata.
   */
  async createProject(
    session: Session,
    request: { readonly format: ProductionFormat; readonly title: string; readonly spec: ProjectSpec },
  ): Promise<{ readonly project: StudioProject; readonly revision: number }> {
    const directory = this.directoryOf(session)
    const stored = await this.store.readDocument(directory, PROJECT_FILE, parseProject)
    if (stored !== undefined) throw new Error('canvas: the project already has project.json')
    const empty: StudioProject = {
      version: 1,
      revision: 0,
      format: request.format,
      title: request.title,
      spec: request.spec,
      episodes: [{ id: brandString<EpisodeId>('e1'), title: '第 1 集', file: 'canvas.json' }],
      bindings: {},
    }
    const { value, revision } = await this.store.updateDocument(
      directory,
      PROJECT_FILE,
      parseProject,
      () => empty,
      current => ({
        document: current,
        value: current,
      }),
    )
    this.emitProjectChange(directory, revision)
    return { project: { ...value, revision }, revision }
  }

  /**
   * Add an episode to the project.
   * @param session - Session opened on the project.
   * @param title - title of the new episode.
   * @returns the new episode and the project revision.
   * @throws Error when the project has no metadata.
   */
  async createEpisode(
    session: Session,
    title: string,
  ): Promise<{ readonly episode: CanvasEpisode; readonly revision: number }> {
    const directory = this.directoryOf(session)
    const created = await this.store.updateDocument(
      directory,
      PROJECT_FILE,
      parseProject,
      missingProject,
      (current) => {
        const next = withEpisode(current, title)
        return { document: next.project, value: { id: next.episode.id, title: next.episode.title } }
      },
    )
    this.emitProjectChange(directory, created.revision)
    return { episode: created.value, revision: created.revision }
  }

  /**
   * Bind a Session to an episode.
   * @param session - Session opened on the project.
   * @param episode - episode the Session edits.
   * @returns the project revision after the binding.
   * @throws Error when the episode does not exist.
   */
  async useEpisode(session: Session, episode: EpisodeId): Promise<{ readonly revision: number }> {
    const directory = this.directoryOf(session)
    const written = await this.store.updateDocument(
      directory,
      PROJECT_FILE,
      parseProject,
      missingProject,
      current => ({
        document: withBinding(current, session.id, episode),
        value: undefined,
      }),
    )
    this.emitProjectChange(directory, written.revision)
    return { revision: written.revision }
  }

  /**
   * Update the bible of a Session's project.
   * @param session - Session opened on the project.
   * @param change - fields to replace, entries to upsert, and entries to remove.
   * @param baseRevision - bible revision the caller read, or undefined to skip the check.
   * @returns the bible after the write and its revision.
   * @throws `CanvasConflictError` when the bible moved past the caller's base revision.
   * @throws Error when a removed entry is still referenced by a storyboard.
   */
  async updateBible(
    session: Session,
    change: {
      readonly logline?: string | undefined
      readonly style?: Partial<Bible['style']> | undefined
      readonly upsert?: readonly BibleEntry[] | undefined
      readonly remove?: readonly BibleEntryId[] | undefined
    },
    baseRevision?: number,
  ): Promise<{ readonly bible: Bible; readonly revision: number }> {
    const directory = this.directoryOf(session)
    const references = await this.bibleReferences(session)
    const blocked = (change.remove ?? []).filter(entry => (references.get(entry) ?? []).length > 0)
    if (blocked.length > 0)
      throw new Error(`canvas: bible entry ${blocked.join(', ')} is still referenced by a storyboard`)
    const written = await this.store.updateDocument(
      directory,
      bibleFile(),
      parseBible,
      () => EMPTY_BIBLE,
      (current) => {
        if (baseRevision !== undefined && baseRevision !== current.revision)
          throw new CanvasConflictError(baseRevision, current.revision)
        const removed = change.remove ?? []
        const upserted = (change.upsert ?? []).map(normalizeBibleAliases)
        const next: Bible = {
          ...current,
          ...(change.logline === undefined ? {} : { logline: change.logline }),
          style: { ...current.style, ...change.style },
          // An upsert replaces the entry with the same id instead of appending a duplicate.
          entries: [
            ...current.entries.filter(
              entry => !removed.includes(entry.id) && !upserted.some(change => change.id === entry.id),
            ),
            ...upserted,
          ],
        }
        return { document: next, value: next }
      },
    )
    const bible = (await this.bibleOf(session)).bible
    this.ctx.emit('canvas/change', { directory, revisions: { bible: written.revision } })
    return { bible, revision: written.revision }
  }

  /**
   * Read the canvas and the revisions a Client needs to render it.
   * @param session - Session opened on the project.
   * @param episode - episode to read; the Session's binding applies when omitted.
   * @returns the directory, episode, revisions, and document.
   * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
   */
  @Remote('get')
  async get(session: Session, episode?: EpisodeId): Promise<CanvasView> {
    const target = await this.targetOf(session, episode)
    await this.ctx.parallel('canvas/open', session, target.episode.id)
    const document = await this.remote(target.directory, target.file, () =>
      this.read(session, target.episode.id, target.directory),
    )
    return {
      directory: target.directory,
      episode: target.episode,
      revisions: { canvas: document.revision },
      document,
      segments: storyboardSegments(document, this.limits.maxSegmentSeconds),
    }
  }

  /**
   * Apply a user's edits to the canvas of an episode.
   * @param session - Session opened on the project.
   * @param operations - ordered operations.
   * @param baseRevision - revision the Client read.
   * @param episode - episode to edit; the Session's binding applies when omitted.
   * @param expectedDirectory - captured project directory; a project switch refuses the write.
   * @returns assigned ids, the new revision, and the skipped operations.
   * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
   */
  @Remote('apply')
  apply(
    session: Session,
    operations: CanvasOperation[],
    baseRevision: number,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<CanvasEditResult> {
    const directory = this.directoryOf(session)
    return this.remote(directory, 'canvas.json', () =>
      this.edit(session, operations, {
        baseRevision,
        origin: 'user',
        ...(episode === undefined ? {} : { episode }),
        ...(expectedDirectory === undefined ? {} : { expectedDirectory }),
      }),
    )
  }

  /**
   * Read the shared bible the Client panels show.
   * @param session - Session opened on the project.
   * @returns the bible and its revision.
   * @throws RemoteError `canvas/corrupt` when the bible file is not a valid bible.
   */
  @Remote('bible')
  bible(session: Session): Promise<{ readonly bible: Bible; readonly revision: number }> {
    const directory = this.directoryOf(session)
    return this.remote(directory, bibleFile(), () => this.bibleOf(session))
  }

  /**
   * Read the independent document of a timeline node.
   * @param session - Session that owns the canvas.
   * @param node - timeline node to open.
   * @param episode - episode to read; the Session binding applies when omitted.
   * @returns validated timeline, or undefined before its first edit.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   */
  @Remote('timeline')
  async timeline(
    session: Session,
    node: CanvasNodeId,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<Timeline | undefined> {
    const target = await this.remote(this.directoryOf(session), PROJECT_FILE, () =>
      this.targetOf(session, episode, expectedDirectory),
    )
    const file = this.timelineFile(target, node)
    return this.remote(target.directory, file, async () => {
      await this.requireTimelineNode(target, node)
      return (await this.store.readDocument(target.directory, file, parseTimeline))?.value
    })
  }

  /**
   * Commit editor or Agent commands against the revision they read.
   * @param session - Session that owns the canvas.
   * @param node - timeline node to edit.
   * @param operations - atomic command batch.
   * @param baseRevision - timeline revision the caller read, 0 before the first edit.
   * @param spec - required output specification for the first edit; later edits use set_spec.
   * @param episode - episode to edit; the Session binding applies when omitted.
   * @returns committed document and intervals requiring a new preview.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   */
  @Remote('editTimeline')
  async editTimeline(
    session: Session,
    node: CanvasNodeId,
    operations: TimelineOperation[],
    baseRevision: number,
    spec: Timeline['spec'] | undefined,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<TimelineEditResult> {
    const target = await this.remote(this.directoryOf(session), PROJECT_FILE, async () => {
      if (operations.length > this.limits.maxBatchOperations) throw new CanvasInputError('too many timeline operations')
      return this.targetOf(session, episode, expectedDirectory)
    })
    return this.commitTimeline(
      target,
      node,
      current => ({ operations, history: current.revision === 0 ? {} : { undo: current.revision } }),
      baseRevision,
      spec,
    )
  }

  /**
   * List saved revisions under the project writer; no media paths or clip bodies cross this read.
   * @param session - project Session.
   * @param node - timeline node.
   * @param episode - explicit episode; omitted uses the Session binding.
   * @param expectedDirectory - captured project directory; omitted skips the directory fence.
   * @returns live revision first followed by available predecessors; empty before initialization.
   */
  @Remote('timelineHistory')
  async timelineHistory(
    session: Session,
    node: CanvasNodeId,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<readonly TimelineRevision[]> {
    const target = await this.remote(this.directoryOf(session), PROJECT_FILE, () =>
      this.targetOf(session, episode, expectedDirectory),
    )
    const file = this.timelineFile(target, node)
    return this.remote(target.directory, file, () =>
      this.store.updateCanvas(target.directory, target.file, async () => {
        await this.requireTimelineNode(target, node)
        const documents = await this.store.documentHistory(
          target.directory,
          file,
          parseTimeline,
          this.limits.timelineHistoryLimit,
        )
        return {
          value: documents.map((document) => {
            const undo = document.history === undefined ? document.revision - 1 : document.history.undo
            const redo = document.history?.redo
            return {
              revision: document.revision,
              spec: document.spec,
              tracks: document.tracks.length,
              clips: document.tracks.reduce((count, track) => count + track.clips.length, 0),
              durationMs: timelineDuration(document),
              ...(undo !== undefined && documents.some(saved => saved.revision === undo) ? { undo } : {}),
              ...(redo !== undefined && documents.some(saved => saved.revision === redo) ? { redo } : {}),
            }
          }),
        }
      }),
    )
  }

  /**
   * Restore by applying shared commands to the caller's revision. Existing generations remain unchanged.
   * @param session - project Session.
   * @param node - timeline node.
   * @param revision - saved revision to restore.
   * @param baseRevision - live revision the user or Agent reviewed.
   * @param mode - explicit restoration or a checked undo/redo cursor step.
   * @param episode - explicit episode; omitted uses the Session binding.
   * @param expectedDirectory - captured project directory; omitted skips the directory fence.
   * @returns newly committed revision and invalidated intervals; unchanged for the live revision itself.
   */
  @Remote('restoreTimeline')
  async restoreTimeline(
    session: Session,
    node: CanvasNodeId,
    revision: number,
    baseRevision: number,
    mode: TimelineRestoreMode,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<TimelineEditResult> {
    const target = await this.remote(this.directoryOf(session), PROJECT_FILE, async () => {
      if (!Number.isSafeInteger(revision) || revision < 1) throw new CanvasInputError('invalid history revision')
      return this.targetOf(session, episode, expectedDirectory)
    })
    return this.commitTimeline(
      target,
      node,
      async (current) => {
        const saved = await this.store.documentHistory(
          target.directory,
          this.timelineFile(target, node),
          parseTimeline,
          this.limits.timelineHistoryLimit,
        )
        const document = saved.find(document => document.revision === revision)
        if (document === undefined) throw new CanvasInputError('history revision is no longer available')
        const undo = current.history === undefined ? current.revision - 1 : current.history.undo
        if ((mode === 'undo' && undo !== revision) || (mode === 'redo' && current.history?.redo !== revision))
          throw new CanvasInputError('history cursor changed; reload before undo or redo')
        const prior =
          document.history === undefined
            ? document.revision > 1
              ? document.revision - 1
              : undefined
            : document.history.undo
        const history =
          mode === 'undo'
            ? { ...(prior === undefined ? {} : { undo: prior }), redo: current.revision }
            : mode === 'redo'
              ? {
                undo: current.revision,
                ...(document.history?.redo === undefined ? {} : { redo: document.history.redo }),
              }
              : { undo: current.revision }
        const operations: readonly TimelineOperation[] =
          current.revision === revision
            ? []
            : [
              ...current.tracks.map(track => ({ op: 'remove_track' as const, track: track.id })),
              { op: 'set_spec' as const, spec: document.spec },
              ...document.tracks.map(track => ({ op: 'add_track' as const, track })),
            ]
        return { operations, history }
      },
      baseRevision,
      undefined,
    )
  }

  /** Both direct edits and history restores enter the same project queue and source validation. */
  private async commitTimeline(
    target: CanvasTarget,
    node: CanvasNodeId,
    commands: (
      current: Timeline,
    ) =>
      | { readonly operations: readonly TimelineOperation[]; readonly history: NonNullable<Timeline['history']> }
      | Promise<{
        readonly operations: readonly TimelineOperation[]
        readonly history: NonNullable<Timeline['history']>
      }>,
    baseRevision: number,
    spec: Timeline['spec'] | undefined,
  ): Promise<TimelineEditResult> {
    const file = this.timelineFile(target, node)
    return this.remote(target.directory, file, async () => {
      const notification = { changed: false }
      const written = await this.store.updateDocument(
        target.directory,
        file,
        parseTimeline,
        () => {
          if (spec === undefined) throw new CanvasInputError('choose timeline dimensions and frame rate before editing')
          return parseTimeline(JSON.stringify({ version: 1, revision: 0, spec, tracks: [] }))
        },
        async (current) => {
          await this.requireTimelineNode(target, node)
          if (current.revision !== baseRevision) throw new CanvasConflictError(baseRevision, current.revision)
          const { operations, history } = await commands(current)
          let edited: TimelineEditResult
          try {
            edited = applyTimeline(current, operations, baseRevision)
          } catch (error: unknown) {
            if (error instanceof CanvasCorruptError) throw new CanvasInputError(error.reason)
            throw error
          }
          const outcome = operations.length === 0 ? edited : { ...edited, document: { ...edited.document, history } }
          const canvas = await this.store.readCanvas(target.directory, target.file)
          for (const track of outcome.document.tracks) {
            for (const clip of track.clips) {
              if (clip.source === undefined) continue
              const input = canvas.nodes.find(candidate => candidate.id === clip.source?.node)
              const allowed = track.kind === 'video' ? ['video', 'image'] : ['audio', 'video']
              if (input === undefined || !allowed.includes(input.type))
                throw new CanvasInputError(`clip ${clip.id} has an incompatible source`)
              const version = input.versions?.find(candidate => candidate.id === clip.source?.version)
              if (version?.path === undefined || !(await isFile(resolve(target.directory, version.path))))
                throw new CanvasInputError(`clip ${clip.id} source version is unavailable`)
              if (
                input.type !== 'image' &&
                version.durationMs !== undefined &&
                clip.source.inMs + clip.durationMs > version.durationMs
              ) {
                throw new CanvasInputError(`clip ${clip.id} exceeds the source duration`)
              }
            }
          }
          notification.changed = operations.length !== 0
          return { ...(notification.changed ? { document: outcome.document } : {}), value: outcome }
        },
        this.limits.timelineHistoryLimit,
      )
      const outcome = { ...written.value, document: { ...written.value.document, revision: written.revision } }
      if (notification.changed)
        this.ctx.emit('canvas/change', {
          directory: target.directory,
          episode: target.episode.id,
          revisions: { timelines: [{ node, revision: written.revision }] },
        })
      return outcome
    })
  }

  /** Resolve only canonical node and episode paths; wire ids cannot choose filesystem paths. */
  private timelineFile(target: CanvasTarget, node: CanvasNodeId): string {
    if (!/^n[1-9][0-9]*$/.test(node)) throw new CanvasInputError('invalid timeline node id')
    return `${target.file}.timelines/${node}.json`
  }

  /** Confirm node identity under the project writer's serialization lock when editing. */
  private async requireTimelineNode(target: CanvasTarget, node: CanvasNodeId): Promise<void> {
    const canvas = await this.store.readCanvas(target.directory, target.file)
    if (!canvas.nodes.some(candidate => candidate.id === node && candidate.type === 'timeline')) {
      throw new CanvasInputError(`canvas node ${node} is not a timeline`)
    }
  }

  /** Read the project metadata, or undefined when the project has none. */
  private async readProject(session: Session): Promise<StudioProject | undefined> {
    const stored = await this.store.readDocument(this.directoryOf(session), PROJECT_FILE, parseProject)
    return stored?.value
  }

  /** Announce a write of a project-level file. */
  private emitProjectChange(directory: string, revision: number): void {
    this.ctx.emit('canvas/change', { directory, revisions: { project: revision } })
  }

  /** Map the canvas errors a Client can handle to Remote errors, and pass the rest through. */
  private async remote<T>(directory: string, file: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error: unknown) {
      if (error instanceof CanvasInputError)
        throw new RemoteError('canvas/invalid-input', error.message, { reason: error.message }, { cause: error })
      if (error instanceof CanvasUnsupportedVersionError) {
        throw new RemoteError(
          'canvas/unsupported-version',
          error.message,
          { file: canvasFile(directory, file), version: error.version },
          { cause: error },
        )
      }
      if (error instanceof CanvasConflictError) {
        throw new RemoteError(
          'canvas/conflict',
          error.message,
          { expected: error.expected, actual: error.actual },
          { cause: error },
        )
      }
      if (!(error instanceof CanvasCorruptError)) throw error
      throw new RemoteError(
        'canvas/corrupt',
        error.message,
        { file: canvasFile(directory, file), reason: error.reason },
        { cause: error },
      )
    }
  }
}

/** The project a directory that never created one behaves as, for writers that require it. */
function missingProject(): never {
  throw new Error('canvas: the project has no project.json; create it first')
}

export default CanvasService
