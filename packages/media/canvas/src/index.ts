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
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-working-directory'
import { bibleFile, EMPTY_BIBLE, parseBible, type Bible, type BibleEntry } from './bible.ts'
import type z from '@deepseek-ai/schemastery'
import { Config as configSchema, resolveConfig, type Config, type ResolvedConfig } from './config.ts'
import { activeVersionOf, assertWithinLimits, CanvasCorruptError, CanvasUnsupportedVersionError } from './document.ts'
import { applyOperations, CanvasConflictError, checkRevision } from './operations.ts'
import { episodeOf, parseProject, withBinding, withEpisode, type ProjectSpec, type ProductionFormat, type StudioProject } from './project.ts'
import { advanceStage, EMPTY_PRODUCTION, parseProductionFile, stageOf } from './production.ts'
import { canvasFile, CanvasStore } from './store.ts'
import { registerCanvasTools } from './tools.ts'
import type {
  BibleEntryId, CanvasDocument, CanvasEditResult, CanvasEpisode, CanvasNode, CanvasOperation, CanvasView, EpisodeId, GateId,
  Production, StageId,
} from './types.ts'

export type * from './types.ts'
export { activeVersionOf, CanvasCorruptError, CanvasUnsupportedVersionError } from './document.ts'
export { CanvasConflictError } from './operations.ts'
export { Config } from './config.ts'
export type { StudioProject, ProjectSpec, ProductionFormat } from './project.ts'
export { gateBibleFirst, gateStoryboardQuality, STAGE_ORDER, videoNodesByShots } from './production.ts'
export { planShotSegments, shotSegmentKind } from './segments.ts'
export type { Bible, BibleEntry } from './bible.ts'

/** Project metadata file relative to `.canvas/`. */
const PROJECT_FILE = 'project.json'

/** Production record file relative to `.canvas/`. */
const PRODUCTION_FILE = 'production.json'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Project canvas documents and the `canvas` Remote namespace. */
    canvas: CanvasService
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
  static inject = ['tools', 'workingDirectory']

  static Config: z<Config> = configSchema

  private readonly store: CanvasStore
  private readonly limits: ResolvedConfig

  /**
   * @param ctx - Host context carrying the tool registry and Session directories.
   * @param config - deployment bounds for canvas documents.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'canvas')
    this.limits = resolveConfig(config)
    this.store = new CanvasStore(this.limits)
    registerCanvasTools(ctx, this)
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
   */
  async targetOf(session: Session, episode?: EpisodeId): Promise<CanvasTarget> {
    const directory = this.directoryOf(session)
    const project = await this.readProject(session)
    if (project === undefined) {
      return { directory, project: undefined, episode: { id: brandString<EpisodeId>('e1'), title: 'Canvas' }, file: 'canvas.json' }
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
   */
  async read(session: Session, episode?: EpisodeId): Promise<CanvasDocument> {
    const target = await this.targetOf(session, episode)
    return this.store.readCanvas(target.directory, target.file)
  }

  /**
   * Apply operations to the canvas of a Session's project in one write.
   * @param session - Session opened on the project.
   * @param operations - ordered operations; relative media paths resolve against the project directory.
   * @param options - base revision the caller read, episode to edit, and who prompted the change.
   * @returns assigned ids, the revision after the write, and the skipped operations with their reasons.
   * @throws `CanvasCorruptError` when the canvas file is not a valid document.
   * @throws `CanvasConflictError` when the document moved past the caller's base revision.
   */
  async edit(
    session: Session,
    operations: readonly CanvasOperation[],
    options: { readonly baseRevision?: number; readonly episode?: EpisodeId; readonly origin?: 'agent' | 'user' } = {},
  ): Promise<CanvasEditResult> {
    if (operations.length > this.limits.maxBatchOperations) {
      throw new Error(`canvas: ${String(operations.length)} operations exceed the ${String(this.limits.maxBatchOperations)} this deployment accepts`)
    }
    const target = await this.targetOf(session, options.episode)
    const rejected = new Map<number, string>()
    const prepared = await Promise.all(operations.map(async (operation, index) => {
      if ((operation.op !== 'add' && operation.op !== 'update') || operation.path === undefined) return operation
      const path = isAbsolute(operation.path) ? operation.path : resolve(target.directory, operation.path)
      if (!await isFile(path)) rejected.set(index, `file ${operation.path} does not exist`)
      return { ...operation, path }
    }))
    let changed = false
    const result = await this.store.updateCanvas(target.directory, target.file, (current) => {
      checkRevision(current, options.baseRevision)
      const outcome = applyOperations(current, prepared, {
        limits: this.limits,
        ...options.origin === undefined ? {} : { origin: options.origin },
        rejected,
      })
      assertWithinLimits(outcome.document, this.limits)
      changed = outcome.changed
      return { ...outcome.changed ? { document: outcome.document } : {}, value: outcome.result }
    })
    if (changed) {
      this.ctx.emit('canvas/change', { directory: target.directory, episode: target.episode.id, revisions: { canvas: result.revision } })
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
        const images = document.nodes.filter(member => member.group === id && member.type === 'image')
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
   * @returns the bible, or an empty one when the project has none, with the revision the file holds.
   */
  async bibleOf(session: Session): Promise<{ readonly bible: Bible; readonly revision: number }> {
    const stored = await this.store.readDocument(this.directoryOf(session), bibleFile(), parseBible)
    return stored === undefined ? { bible: EMPTY_BIBLE, revision: 0 } : { bible: stored.value, revision: stored.revision }
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
        const shots = node.type === 'storyboard' ? activeVersionOf(node)?.shots ?? [] : []
        for (const shot of shots) {
          const used = [...shot.characters, ...shot.props, ...shot.scene === undefined ? [] : [shot.scene]]
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
    const written = await this.store.updateDocument(directory, PRODUCTION_FILE, parseProductionFile, () => EMPTY_PRODUCTION, (current) => {
      if (baseRevision !== undefined && baseRevision !== current.revision) throw new CanvasConflictError(baseRevision, current.revision)
      return { document: advanceStage(current, target.episode.id, to, override, at), value: undefined }
    })
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
    const { value, revision } = await this.store.updateDocument(directory, PROJECT_FILE, parseProject, () => empty, current => ({
      document: current,
      value: current,
    }))
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
  async createEpisode(session: Session, title: string): Promise<{ readonly episode: CanvasEpisode; readonly revision: number }> {
    const directory = this.directoryOf(session)
    const created = await this.store.updateDocument(directory, PROJECT_FILE, parseProject, missingProject, (current) => {
      const next = withEpisode(current, title)
      return { document: next.project, value: { id: next.episode.id, title: next.episode.title } }
    })
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
    const written = await this.store.updateDocument(directory, PROJECT_FILE, parseProject, missingProject, current => ({
      document: withBinding(current, session.id, episode),
      value: undefined,
    }))
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
    if (blocked.length > 0) throw new Error(`canvas: bible entry ${blocked.join(', ')} is still referenced by a storyboard`)
    const written = await this.store.updateDocument(directory, bibleFile(), parseBible, () => EMPTY_BIBLE, (current) => {
      if (baseRevision !== undefined && baseRevision !== current.revision) throw new CanvasConflictError(baseRevision, current.revision)
      const removed = change.remove ?? []
      const upserted = change.upsert ?? []
      const next: Bible = {
        ...current,
        ...change.logline === undefined ? {} : { logline: change.logline },
        style: { ...current.style, ...change.style },
        // An upsert replaces the entry with the same id instead of appending a duplicate.
        entries: [
          ...current.entries.filter(entry => !removed.includes(entry.id) && !upserted.some(change => change.id === entry.id)),
          ...upserted,
        ],
      }
      return { document: next, value: next }
    })
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
    const document = await this.remote(target.directory, target.file, () => this.read(session, target.episode.id))
    return { directory: target.directory, episode: target.episode, revisions: { canvas: document.revision }, document }
  }

  /**
   * Apply a user's edits to the canvas of an episode.
   * @param session - Session opened on the project.
   * @param operations - ordered operations.
   * @param baseRevision - revision the Client read.
   * @param episode - episode to edit; the Session's binding applies when omitted.
   * @returns assigned ids, the new revision, and the skipped operations.
   * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
   */
  @Remote('apply')
  apply(session: Session, operations: CanvasOperation[], baseRevision: number, episode?: EpisodeId): Promise<CanvasEditResult> {
    const directory = this.directoryOf(session)
    return this.remote(directory, 'canvas.json', () => this.edit(session, operations, {
      baseRevision,
      origin: 'user',
      ...episode === undefined ? {} : { episode },
    }))
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
      if (error instanceof CanvasUnsupportedVersionError) {
        throw new RemoteError('canvas/unsupported-version', error.message, { file: canvasFile(directory, file), version: error.version }, { cause: error })
      }
      if (error instanceof CanvasConflictError) {
        throw new RemoteError('canvas/conflict', error.message, { expected: error.expected, actual: error.actual }, { cause: error })
      }
      if (!(error instanceof CanvasCorruptError)) throw error
      throw new RemoteError('canvas/corrupt', error.message, { file: canvasFile(directory, file), reason: error.reason }, { cause: error })
    }
  }
}

/** The project a directory that never created one behaves as, for writers that require it. */
function missingProject(): never {
  throw new Error('canvas: the project has no project.json; create it first')
}

export default CanvasService
