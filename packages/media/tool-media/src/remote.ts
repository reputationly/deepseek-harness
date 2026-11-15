/** Remote `media` namespace: the capability catalog and generation a Client drives. */
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-file-upload'
import type {} from '@deepseek-ai/dsh-attachment'
import { capabilitiesFor, type MediaCatalog } from './catalog.ts'
import type { MediaCapabilityView, MediaPlanView } from './types.ts'
import type { CanvasNodeId, CanvasScope, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import { CanvasConflictError, CanvasInputError } from '@deepseek-ai/dsh-canvas'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { TimelineRenderError, type TimelineRenderer } from './timeline-render.ts'
import { LocalMediaEditError, type LocalMediaEditor } from './local-edit.ts'
import type {
  LocalMediaEditRequest,
  LocalMediaEditResult,
  LocalMediaImportRequest,
  LocalVideoImportRequest,
} from './local-edit-types.ts'
import type { LocalMediaImporter } from './media-import.ts'
import type {
  TimelineRenderErrorCode,
  TimelineRenderLease,
  TimelineRenderPart,
  TimelineRenderView,
  TimelineRenderWork,
  TimelineExportResult,
  TimelineRenderAsset,
} from './timeline-render-types.ts'

/** Host calls the Remote namespace delegates to. */
export interface MediaRuntime {
  /** Prepare a local preview of a recorded video version. */
  readonly preview: (session: Session, node: CanvasNodeId, version: VersionId, scope: CanvasScope) => Promise<string>
  /** Plan the nodes without changing the canvas or starting work. */
  readonly plan: (session: Session, nodes: readonly string[], scope?: CanvasScope) => Promise<MediaPlanView>
  /** Start the plan, presenting the confirmation token when the user agreed to the totals. */
  readonly generate: (
    session: Session,
    nodes: readonly string[],
    token: string | undefined,
    scope?: CanvasScope,
  ) => Promise<MediaPlanView>
  /** Cancel one running media job the Session owns. */
  readonly cancel: (session: Session, jobId: string) => boolean
}

/** Remote service a Client reads media capabilities and plans generations through. */
export class MediaService extends TypertRemoteService {
  /**
   * @param ctx - owning Context.
   * @param catalog - reads the deployment's capability catalog, when it has one.
   * @param runtime - plans and starts generation for one Session.
   */
  constructor(
    ctx: Context,
    private readonly catalog: () => Promise<MediaCatalog | undefined>,
    private readonly runtime: MediaRuntime,
    private readonly renderer?: TimelineRenderer,
    private readonly editor?: Pick<LocalMediaEditor, 'edit'>,
    private readonly importer?: Pick<LocalMediaImporter, 'import'>,
  ) {
    super(ctx, 'media')
  }

  /**
   * Run a managed local edit and save its result as an unadopted candidate. Repeating the exact
   * request reuses its result; failed attachment retains completed bytes in the error details.
   * Cancellation stops processing before a canvas commit starts; it cannot undo an acknowledged commit.
   * @param session - Session owning the captured project and managed job.
   * @param request - explicit source version, project, episode, and processing parameters.
   * @returns the saved candidate without changing adoption.
   */
  @Remote('editMedia')
  async editMedia(session: Session, request: LocalMediaEditRequest): Promise<LocalMediaEditResult> {
    return this.editing(async () => {
      if (this.editor === undefined) throw new LocalMediaEditError('processing', 'Local media editing is unavailable')
      return this.editor.edit(session, request, 'none')
    })
  }

  /**
   * Import a staged upload through its receiving Agent, verifying bytes before publishing a candidate.
   * @param agent - receiver resolved from the exact Session used for the upload.
   * @param request - upload receipt, destination video node, and captured project scope.
   * @returns an unadopted candidate; completed project files survive failed attachment.
   */
  @Remote('importVideo')
  async importVideo(agent: Agent, request: LocalVideoImportRequest): Promise<LocalMediaEditResult> {
    return this.editing(async () => {
      const uploads = this.ctx.get('fileUploads'),
        attachments = this.ctx.get('attachments')
      if (this.importer === undefined || uploads === undefined || attachments === undefined)
        throw new LocalMediaEditError('processing', 'Media uploads are unavailable')
      const staged = uploads.resolve(agent, request.receipt)
      if (staged?.type !== 'file')
        throw new LocalMediaEditError(
          'input',
          'The upload receipt is unknown or belongs to another Session; upload the file again',
        )
      return this.importer.import(agent.session, request, {
        key: staged.attachment.attachmentId,
        name: staged.attachment.name,
        data: signal => attachments.readFileStream(staged.attachment, signal),
      })
    })
  }

  /**
   * Import local music or speech without generating media or adopting its candidate.
   * @param agent - receiver whose staged upload registry owns the receipt.
   * @param request - captured project, audio node, and verified upload receipt.
   * @returns the saved candidate; completed files remain available after failed attachment.
   */
  @Remote('importAudio')
  async importAudio(agent: Agent, request: LocalMediaImportRequest): Promise<LocalMediaEditResult> {
    return this.editing(async () => {
      const uploads = this.ctx.get('fileUploads'),
        attachments = this.ctx.get('attachments')
      if (this.importer === undefined || uploads === undefined || attachments === undefined)
        throw new LocalMediaEditError('processing', 'Media uploads are unavailable')
      const staged = uploads.resolve(agent, request.receipt)
      if (staged?.type !== 'file')
        throw new LocalMediaEditError(
          'input',
          'The upload receipt is unknown or belongs to another Session; upload the file again',
        )
      return this.importer.import(
        agent.session,
        request,
        {
          key: staged.attachment.attachmentId,
          name: staged.attachment.name,
          data: signal => attachments.readFileStream(staged.attachment, signal),
        },
        'audio',
      )
    })
  }

  private async editing<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error: unknown) {
      if (error instanceof LocalMediaEditError)
        throw new RemoteError(
          'media/edit',
          error.message,
          { kind: error.code, ...(error.path === undefined ? {} : { path: error.path }) },
          { cause: error },
        )
      if (error instanceof CanvasInputError)
        throw new RemoteError('media/edit', error.message, { kind: 'input' }, { cause: error })
      throw error
    }
  }

  private async rendering<T>(run: (renderer: TimelineRenderer) => Promise<T> | T): Promise<T> {
    try {
      if (this.renderer === undefined)
        throw new TimelineRenderError('renderer', 'local timeline rendering is unavailable')
      return await run(this.renderer)
    } catch (error: unknown) {
      if (error instanceof TimelineRenderError)
        throw new RemoteError('media/render', error.message, { kind: error.code }, { cause: error })
      if (error instanceof CanvasConflictError)
        throw new RemoteError(
          'canvas/conflict',
          error.message,
          { expected: error.expected, actual: error.actual },
          { cause: error },
        )
      if (error instanceof CanvasInputError)
        throw new RemoteError('media/render', error.message, { kind: 'source' }, { cause: error })
      throw error
    }
  }

  /**
   * Read the current revision and availability of its full-quality preview.
   * @returns the current revision's full-quality preview and local render state.
   * @param session - Session that owns the project and render task.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param episode - Explicit episode; omission uses the Session binding.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   */
  @Remote('timelineStatus')
  timelineStatus(
    session: Session,
    node: CanvasNodeId,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<TimelineRenderView> {
    return this.rendering(renderer => renderer.status(session, node, episode, expectedDirectory))
  }
  /**
   * Queue a revision-checked local render. Repeated starts reuse a live job or its finished file.
   * @param session - Session that owns the project and render task.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param revision - Reviewed timeline revision that must still be current.
   * @param episode - Explicit episode; omission uses the Session binding.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   * @returns The existing or newly queued render state.
   */
  @Remote('renderTimeline')
  renderTimeline(
    session: Session,
    node: CanvasNodeId,
    revision: number,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<TimelineRenderView> {
    return this.rendering(renderer => renderer.start(session, node, revision, episode, expectedDirectory, 'none'))
  }
  /**
   * Discover unclaimed jobs after the renderer connects or recovers its transport.
   * @returns unclaimed local jobs; used to resume a connected renderer after transport recovery.
   * @param session - Session that owns the project and render task.
   */
  @Remote('pendingTimelineRenders')
  pendingTimelineRenders(session: Session): Promise<JobId[]> {
    return this.rendering(renderer => renderer.pending(session))
  }
  /**
   * Acquire exclusive render work and its reusable cache blocks.
   * @returns exclusive work and reusable blocks, or undefined when another renderer claimed it.
   * @param session - Session that owns the project and render task.
   * @param job - Opaque render job identity.
   * @param environment - Renderer codec and font environment identity.
   */
  @Remote('claimTimelineRender')
  claimTimelineRender(session: Session, job: JobId, environment: string): Promise<TimelineRenderWork | undefined> {
    return this.rendering(renderer => renderer.claim(session, job, environment))
  }
  /**
   * Append a bounded byte window to a producer-owned temporary file; caller paths are never accepted.
   * @param session - Session that owns the project and render task.
   * @param job - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param part - Host-issued segment or final-output upload identity.
   * @param offset - Expected append offset in bytes.
   * @param data - Base64-encoded bounded upload chunk.
   * @returns The accepted byte offset for the next upload.
   */
  @Remote('appendTimelineRender')
  appendTimelineRender(
    session: Session,
    job: JobId,
    lease: TimelineRenderLease,
    part: TimelineRenderPart,
    offset: number,
    data: string,
  ): Promise<number> {
    return this.rendering(renderer => renderer.appendEncoded(session, job, lease, part, offset, data))
  }
  /**
   * Probe and atomically publish a complete block or the final preview file.
   * @param session - Session that owns the project and render task.
   * @param job - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param part - Host-issued segment or final-output upload identity.
   * @returns The state after validating and publishing the uploaded part.
   */
  @Remote('completeTimelineRender')
  completeTimelineRender(
    session: Session,
    job: JobId,
    lease: TimelineRenderLease,
    part: TimelineRenderPart,
  ): Promise<TimelineRenderView> {
    return this.rendering(renderer => renderer.complete(session, job, lease, part))
  }
  /**
   * Refresh a live lease and publish rendering/assembly progress.
   * @param session - Session that owns the project and render task.
   * @param job - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param progress - Normalized task progress from zero through one.
   * @param assembling - Whether the renderer is assembling the final full-quality output.
   */
  @Remote('timelineRenderProgress')
  timelineRenderProgress(
    session: Session,
    job: JobId,
    lease: TimelineRenderLease,
    progress: number,
    assembling: boolean,
  ): Promise<void> {
    return this.rendering(renderer => renderer.progress(session, job, lease, progress, assembling))
  }
  /**
   * Stop a failed renderer and retain completed reusable blocks.
   * @param session - Session that owns the project and render task.
   * @param job - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param code - Structured render failure category.
   * @param message - Actionable render failure description.
   */
  @Remote('failTimelineRender')
  failTimelineRender(
    session: Session,
    job: JobId,
    lease: TimelineRenderLease,
    code: TimelineRenderErrorCode,
    message: string,
  ): Promise<void> {
    return this.rendering(renderer => renderer.fail(session, job, lease, code, message))
  }
  /**
   * Clear only this timeline's derived cache after stopping its writer.
   * @param session - Session that owns the project and render task.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param episode - Explicit episode; omission uses the Session binding.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   */
  @Remote('clearTimelineCache')
  clearTimelineCache(
    session: Session,
    node: CanvasNodeId,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<void> {
    return this.rendering(renderer => renderer.clear(session, node, episode, expectedDirectory))
  }
  /**
   * Export exactly the current preview as an immutable MP4 video node.
   * @param session - Session that owns the project and render task.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param revision - Reviewed timeline revision that must still be current.
   * @param episode - Explicit episode; omission uses the Session binding.
   * @param expectedDirectory - Captured project directory used to reject a project switch.
   * @returns The new output node and immutable exported file.
   */
  @Remote('exportTimeline')
  exportTimeline(
    session: Session,
    node: CanvasNodeId,
    revision: number,
    episode?: EpisodeId,
    expectedDirectory?: string,
  ): Promise<TimelineExportResult> {
    return this.rendering(renderer => renderer.export(session, node, revision, episode, 'user', expectedDirectory))
  }
  /**
   * Return an immutable full-resolution H.264/AAC compatibility copy of a pinned source.
   * @param session - Session that owns the project and render task.
   * @param job - Opaque render job identity.
   * @param lease - Ownership token required for every renderer mutation.
   * @param node - Canvas node whose timeline or pinned asset is addressed.
   * @param version - Immutable source version pinned by the render plan.
   * @returns The verified decodable source asset.
   */
  @Remote('compatibleTimelineAsset')
  compatibleTimelineAsset(
    session: Session,
    job: JobId,
    lease: TimelineRenderLease,
    node: CanvasNodeId,
    version: VersionId,
  ): Promise<TimelineRenderAsset> {
    return this.rendering(renderer => renderer.compatible(session, job, lease, node, version))
  }

  /**
   * List the models one gateway operation offers.
   * @param session - Session whose deployment calls the gateway.
   * @param operation - gateway operation such as `generate_video`.
   * @returns one entry per model.
   */
  @Remote('capabilities')
  async capabilities(session: Session, operation: string): Promise<MediaCapabilityView[]> {
    void session
    const catalog = await this.catalog()
    if (catalog === undefined) return []
    return capabilitiesFor(catalog, operation).map(capability => ({
      id: capability.id,
      model: capability.model,
      operation: capability.operation,
      ...(capability.taskTypes === undefined ? {} : { taskTypes: [...capability.taskTypes] }),
      params: Object.entries(capability.paramSchema?.properties ?? {}).map(([id, param]) => ({
        id,
        ...(param.title === undefined ? {} : { title: param.title }),
        ...(param.enum === undefined ? {} : { options: [...param.enum] }),
        ...(param.default === undefined ? {} : { default: param.default }),
        ...(param.type === undefined ? {} : { type: param.type }),
      })),
    }))
  }

  /**
   * Plan the given nodes and their budget without starting work.
   * @param session - Session that owns the canvas.
   * @param nodes - canvas node ids to generate.
   * @param scope - captured editor project and episode, when requested from a canvas application.
   * @returns the plan, its totals, and a confirmation token when the user must agree first.
   */
  @Remote('planNodes')
  planNodes(session: Session, nodes: readonly string[], scope?: CanvasScope): Promise<MediaPlanView> {
    return this.runtime.plan(session, nodes, scope)
  }

  /**
   * Prepare a browser-compatible local copy of a video version, preserving the original.
   * @param session - Session that owns the canvas.
   * @param node - video node id.
   * @param version - recorded version id to preview.
   * @param scope - project directory and episode captured by the rendering canvas.
   * @returns the project-local preview file path.
   */
  @Remote('videoPreview')
  async videoPreview(session: Session, node: CanvasNodeId, version: VersionId, scope: CanvasScope): Promise<string> {
    try {
      return await this.runtime.preview(session, node, version, scope)
    } catch (error: unknown) {
      if (error instanceof CanvasInputError)
        throw new RemoteError('media/render', error.message, { kind: 'source' }, { cause: error })
      throw error
    }
  }

  /**
   * Start the given nodes' generation.
   * @param session - Session that owns the canvas.
   * @param nodes - canvas node ids to generate.
   * @param token - confirmation token from `planNodes`, after the user agreed.
   * @param scope - original editor project and episode, retained through confirmation.
   * @returns the started jobs, or why nothing started.
   */
  @Remote('generateNodes')
  generateNodes(
    session: Session,
    nodes: readonly string[],
    token: string | undefined,
    scope?: CanvasScope,
  ): Promise<MediaPlanView> {
    return this.runtime.generate(session, nodes, token, scope)
  }

  /**
   * Cancel one running media job.
   * @param session - Session that owns the job.
   * @param jobId - job id a plan reported.
   * @returns whether the Host accepted the cancellation.
   */
  @Remote('cancelMediaJob')
  cancelMediaJob(session: Session, jobId: string): boolean {
    return this.runtime.cancel(session, jobId)
  }
}
