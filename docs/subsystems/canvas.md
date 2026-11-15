# Canvas

English | [中文](canvas.zh.md)

The [media package family](../../packages/media/README.md) keeps the canvas documents of one project directory: one canvas per episode, plus the project metadata and the shared bible. The model edits them through tools, the media tools read nodes as inputs and place results on them, and the Web Client shows them beside the conversation. The Host owns the files; every writer goes through the same service.

## Ownership

| Owner | Responsibility |
|---|---|
| [canvas](../../packages/media/canvas/README.md) | `ctx.canvas`: the documents, project and bible files, their validation and atomic writes, automatic layout, the `canvas_*` and `studio_*` tools, and the `canvas` Remote namespace |
| [tool-media](../../packages/media/tool-media/README.md) | Resolves image and video/audio nodes for media operations and places outputs as nodes with versions and derivation edges |
| [Canvas tab Client](../../packages/client/ui-sidebar-canvas/README.md) | Shows nodes, groups, and edges, and sends the user's moves, connections, grouping, and deletions to the Host |

## Documents and operations

`CanvasDocument` is the content of one canvas file — `<project>/.canvas/canvas.json` for a project without metadata, or the file `project.json` names for an episode: content nodes (`image`, `video`, `audio`, `text`, `script`, `storyboard`, `timeline`), groups, and edges of kind `reference` or `derivation`. It carries `version: 3` and a `revision` that every successful edit advances. Formats 1 and 2 migrate on read without rewriting the file. A missing file is an empty canvas. A file that fails validation is never overwritten; a newer format version is refused without writing; reads and edits fail with the reason instead.

Node content lives in `versions`; `activeVersion` names the explicitly adopted version. Generated media remains a candidate until `set_version` adopts it; passing `null` clears adoption. `activeVersionOf` never falls back to a candidate, while `previewVersionOf` can display one without adopting it. Version `inputs` capture exact source nodes, versions, paths, and roles and protect those versions from pruning. A storyboard version holds `shots`; an audio version may hold a detected `beats` grid. `GenerationSpec` on a node says how it generates: kind, prompt, model, parameters, and which shots or dialogue line it belongs to.

Edges carry the role of the input they supply: `prompt`, `ref`, `first_frame`, `last_frame`, `audio`, or `source`, inferred from node kinds when the caller names none. A derivation edge is `<source>-><target>`; a reference edge is `<source>-><target>:<role>`, so one image can be both a reference and the first frame of one video. References keep their `order`.

`CanvasOperation` is one step of an edit: the node operations (`add`, `update`, `remove`, `set_gen`, `set_text`, `set_shots`, `update_shot`, `insert_shot`, `remove_shot`, `move_shot`, `set_version`), the edge operations (`connect`, `disconnect`, `reorder_refs`), and the layout operations (`group`, `ungroup`, `move`, `resize`). One edit applies its operations in order, advances `revision` once, and writes the file once; a shot rewrite inside one call produces one version. An operation that cannot apply, such as one naming an unknown node or closing a cycle, is skipped and listed in `CanvasEditResult`; the others still apply. A caller's stale `baseRevision` fails the whole call before anything is written. Nodes without a position are laid out by dependency depth, and nodes the user moved stay where they are.

`project.json` holds the production format, the episode list, and the Session bindings that decide which episode a Session edits; `bible.json` holds the shared style, characters, locations, and props that prompts reference as `@name`. Both carry their own revision, advanced by the store on every write.

`CanvasView` is the document a Remote caller receives together with its project directory, episode, and file revisions. Each successful edit emits `canvas/change` with a `CanvasChange` naming that directory, the episode, and the revision of each file it wrote; the Remote namespace forwards it to connected Clients.

## Timelines

Each timeline node owns `<canvas-file>.timelines/<node>.json`; immutable snapshots live in `<timeline-file>.history/<revision>.json`. `timelineHistoryLimit` bounds the retained predecessor window (default 100). The Host archives and validates the predecessor before replacing the live file; an archive or cleanup failure leaves the live revision unchanged. Current and retained historical clips protect their source versions from pruning and their source nodes from deletion.

`timeline_get`, `timeline_edit`, `timeline_history`, and `timeline_restore` require explicit `node`, `episode`, and `directory` bindings. The Host rejects a changed project or an absent episode before writing. `timeline_restore` also requires the reviewed `baseRevision` and a `mode` of `restore`, `undo`, or `redo`. Restoration applies shared operations as a new revision. Host-owned `Timeline.history` persists the undo/redo cursor; `TimelineRevision.undo` and `.redo` advertise only targets still available in the retained window. A normal edit or explicit restoration clears the redo branch. Missing history and revision conflicts require rereading and explicit review; neither silently overwrites a draft.

`Timeline` has its own `revision`, a `spec` with even output dimensions and a frame rate of 24, 25, or 30, and ordered `TimelineTrack` layers. Track kinds are `video`, `audio`, and `text`. `TimelineClip` uses integer `startMs` and `durationMs`; its interval includes the start and excludes the end. A media source pins `node`, `version`, and `inMs`. Video tracks accept image/video sources; audio tracks accept audio/video sources; text tracks contain captions. Media in-points and durations cannot exceed a known source duration. Unknown fields and invalid documents are rejected without replacing the stored file.

`TimelineOperation` batches are atomic and require the caller's `baseRevision`. They add/remove tracks and clips, move, trim, split, ripple-delete, patch clip/track settings, or change output specifications. Splitting preserves source offsets and removes the new right clip's incoming transition. Ripple deletion shifts later clips on that track. Successful nonempty batches increment the timeline revision; `TimelineEditResult.invalidated` merges the old and new affected intervals. Canvas revisions remain separate.

The client-safe compositor evaluates the same document for preview and encoding. Video and caption tracks paint in document order; muted tracks contribute neither frames nor audio. Captions use the same grapheme wrapping, font, colors, outline, size, and placement. Transforms use output pixels and rotation in degrees. `dissolve` fades the incoming layer over visible layers; cross-dissolving two moving clips requires an overlap. `fade_black` fills its transformed area before fading in. Image motion runs over the clip's duration. Audio uses source in-points, track/clip gain and linear fades, then limits the combined samples. PCM windows can be evaluated independently without changing their sample positions. Missing visible media prevents the frame from being published.

## Media inputs

`resolveImages` turns node ids into image file paths for generation. An image node stands for its file. A group stands for its image members in reading order, top to bottom and then left to right. Any other node type, an unknown id, or a group without an image fails before the gateway is called.

`resolveMedia` turns image, video, and audio node ids into file paths in input order for editing and probing. It rejects groups, text nodes, nodes without paths, and unknown ids with `CanvasInputError`; `resolveImages` keeps its image and group behavior.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcanvas--canvasservice"></a>

### `ctx.canvas` — `CanvasService`

Owns every project's canvas documents.

```ts cordis-catalog
/**
 * Publish or clear one Session's editor hint for the next logged runtime-context snapshot.
 * @param session - Session owning this UI selection.
 * @param context - captured selection without draft values; omitted when the editor closes.
 * @throws RemoteError when the reported project no longer belongs to this Session; its old hint is cleared.
 */
@Remote('editorContext') editorContext(session: Session, context?: CanvasEditorContext): void

/**
 * Project directory whose canvas a Session edits.
 * @param session - Session opened on the project.
 * @returns the Session's original directory, or its current one when the header records none.
 */
directoryOf(session: Session): string

/**
 * Project, episode, and files one Session edits.
 * @param session - Session opened on the project.
 * @param episode - episode the caller asked for; the Session's binding applies when omitted.
 * @returns the resolved target; a directory without `project.json` reports the single canvas.
 * @throws Error when the requested episode does not exist.
 * @param expectedDirectory - Captured project directory used to reject a project switch.
 */
async targetOf(session: Session, episode?: EpisodeId, expectedDirectory?: string): Promise<CanvasTarget>

/**
 * Read the canvas of a Session's project.
 * @param session - Session opened on the project.
 * @param episode - episode to read; the Session's binding applies when omitted.
 * @returns the validated document; an empty canvas when the project has none.
 * @throws `CanvasCorruptError` when the canvas file is not a valid document.
 * @param expectedDirectory - Captured project directory used to reject a project switch.
 */
async read(session: Session, episode?: EpisodeId, expectedDirectory?: string): Promise<CanvasDocument>

/**
 * Apply operations to the canvas of a Session's project in one write.
 * @param session - Session opened on the project.
 * @param operations - ordered operations; relative media paths resolve against the project directory.
 * @param options - base revision, captured target, origin, and atomic mode to reject the whole batch when any operation is skipped.
 * @returns assigned ids, the revision after the write, and the skipped operations with their reasons.
 * @throws `CanvasCorruptError` when the canvas file is not a valid document.
 * @throws `CanvasConflictError` when the document moved past the caller's base revision.
 */
async edit( session: Session, operations: readonly CanvasOperation[], options: { readonly baseRevision?: number readonly episode?: EpisodeId readonly origin?: 'agent' | 'user' readonly expectedDirectory?: string readonly atomic?: boolean readonly timelineRevisions?: readonly { readonly node: CanvasNodeId; readonly revision: number }[] } = {}, ): Promise<CanvasEditResult>

/**
 * Picture nodes and groups stand for as generation inputs.
 * @param session - Session opened on the project.
 * @param ids - image node ids or group ids; a group stands for its image members in reading order.
 * @returns absolute image paths in input order, without duplicates.
 * @throws {@link CanvasInputError} when an id is unknown, is not an image or group, or is a group without images.
 */
async resolveImages(session: Session, ids: readonly string[]): Promise<string[]>

/**
 * Resolve image, video, and audio nodes to their local media files.
 * @param session - Session opened on the project.
 * @param ids - media node ids in the order the caller will consume them.
 * @returns absolute media paths in input order.
 * @throws {@link CanvasInputError} when an id is unknown, is not a media node, or has no path.
 */
async resolveMedia(session: Session, ids: readonly string[]): Promise<string[]>

/**
 * Read the project metadata and every episode.
 * @param session - Session opened on the project.
 * @returns the project, its revision, the current episode, and the episodes of the project.
 */
async projectOf(session: Session): Promise<{ readonly project: StudioProject | undefined readonly revision: number readonly current: CanvasEpisode readonly episodes: readonly CanvasEpisode[] }>

/**
 * Read the bible of a Session's project.
 * @param session - Session opened on the project.
 * @param expectedDirectory - captured project owner, when called from a running media job.
 * @returns the bible, or an empty one when the project has none, with the revision the file holds.
 */
async bibleOf( session: Session, expectedDirectory?: string, ): Promise<{ readonly bible: Bible; readonly revision: number }>

/**
 * Bible entries the storyboards of every episode of a project reference.
 * @param session - Session opened on the project.
 * @returns the referencing storyboard nodes per entry id.
 */
async bibleReferences(session: Session): Promise<ReadonlyMap<BibleEntryId, readonly string[]>>

/**
 * Read the production record of a Session's project.
 * @param session - Session opened on the project.
 * @returns the production record, an empty one when the project has none, and its revision.
 */
async productionOf(session: Session): Promise<{ readonly production: Production; readonly revision: number }>

/**
 * Record the stage one episode has reached.
 * @param session - Session opened on the project.
 * @param to - stage to record.
 * @param override - gate to record as overridden, with the reason a user gave.
 * @param baseRevision - production revision the caller read, or undefined to skip the check.
 * @returns the production record after the write, its revision, and the previous stage.
 * @throws `CanvasConflictError` when the production moved past the caller's base revision.
 */
async setStage( session: Session, to: StageId, override?: { readonly gate: GateId; readonly reason: string }, baseRevision?: number, ): Promise<{ readonly production: Production; readonly revision: number; readonly previous: StageId }>

/**
 * Create the project metadata, making the existing single canvas its first episode.
 * @param session - Session opened on the project.
 * @param request - production format, title, and output specification.
 * @returns the project after the write and its revision.
 * @throws Error when the project already has metadata.
 */
async createProject( session: Session, request: { readonly format: ProductionFormat; readonly title: string; readonly spec: ProjectSpec }, ): Promise<{ readonly project: StudioProject; readonly revision: number }>

/**
 * Add an episode to the project.
 * @param session - Session opened on the project.
 * @param title - title of the new episode.
 * @returns the new episode and the project revision.
 * @throws Error when the project has no metadata.
 */
async createEpisode( session: Session, title: string, ): Promise<{ readonly episode: CanvasEpisode; readonly revision: number }>

/**
 * Bind a Session to an episode.
 * @param session - Session opened on the project.
 * @param episode - episode the Session edits.
 * @returns the project revision after the binding.
 * @throws Error when the episode does not exist.
 */
async useEpisode(session: Session, episode: EpisodeId): Promise<{ readonly revision: number }>

/**
 * Update the bible of a Session's project.
 * @param session - Session opened on the project.
 * @param change - fields to replace, entries to upsert, and entries to remove.
 * @param baseRevision - bible revision the caller read, or undefined to skip the check.
 * @returns the bible after the write and its revision.
 * @throws `CanvasConflictError` when the bible moved past the caller's base revision.
 * @throws Error when a removed entry is still referenced by a storyboard.
 */
async updateBible( session: Session, change: { readonly logline?: string | undefined readonly style?: Partial<Bible['style']> | undefined readonly upsert?: readonly BibleEntry[] | undefined readonly remove?: readonly BibleEntryId[] | undefined }, baseRevision?: number, ): Promise<{ readonly bible: Bible; readonly revision: number }>

/**
 * Read the canvas and the revisions a Client needs to render it.
 * @param session - Session opened on the project.
 * @param episode - episode to read; the Session's binding applies when omitted.
 * @returns the directory, episode, revisions, and document.
 * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
 */
@Remote('get') async get(session: Session, episode?: EpisodeId): Promise<CanvasView>

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
@Remote('apply') apply( session: Session, operations: CanvasOperation[], baseRevision: number, episode?: EpisodeId, expectedDirectory?: string, ): Promise<CanvasEditResult>

/**
 * Read the shared bible the Client panels show.
 * @param session - Session opened on the project.
 * @returns the bible and its revision.
 * @throws RemoteError `canvas/corrupt` when the bible file is not a valid bible.
 */
@Remote('bible') bible(session: Session): Promise<{ readonly bible: Bible; readonly revision: number }>

/**
 * Read the independent document of a timeline node.
 * @param session - Session that owns the canvas.
 * @param node - timeline node to open.
 * @param episode - episode to read; the Session binding applies when omitted.
 * @returns validated timeline, or undefined before its first edit.
 * @param expectedDirectory - Captured project directory used to reject a project switch.
 */
@Remote('timeline') async timeline( session: Session, node: CanvasNodeId, episode?: EpisodeId, expectedDirectory?: string, ): Promise<Timeline | undefined>

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
@Remote('editTimeline') async editTimeline( session: Session, node: CanvasNodeId, operations: TimelineOperation[], baseRevision: number, spec: Timeline['spec'] | undefined, episode?: EpisodeId, expectedDirectory?: string, ): Promise<TimelineEditResult>

/**
 * List saved revisions under the project writer; no media paths or clip bodies cross this read.
 * @param session - project Session.
 * @param node - timeline node.
 * @param episode - explicit episode; omitted uses the Session binding.
 * @param expectedDirectory - captured project directory; omitted skips the directory fence.
 * @returns live revision first followed by available predecessors; empty before initialization.
 */
@Remote('timelineHistory') async timelineHistory( session: Session, node: CanvasNodeId, episode?: EpisodeId, expectedDirectory?: string, ): Promise<readonly TimelineRevision[]>

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
@Remote('restoreTimeline') async restoreTimeline( session: Session, node: CanvasNodeId, revision: number, baseRevision: number, mode: TimelineRestoreMode, episode?: EpisodeId, expectedDirectory?: string, ): Promise<TimelineEditResult>
```

Types: [Session](session.md)

Source: [`packages/media/canvas/src/index.ts`](../../packages/media/canvas/src/index.ts)

<a id="canvas-events"></a>

### `canvas/*` events

<a id="canvaschange--emit"></a>

#### `canvas/change` — emit

A project's canvas files were rewritten.

```ts cordis-catalog
/**
 * A project's canvas files were rewritten.
 * @mode emit
 * @param change - the project directory, episode, and file revisions that changed.
 */
'canvas/change'(change: CanvasChange): void
```

Source: [`packages/media/canvas/src/types.ts`](../../packages/media/canvas/src/types.ts)

<a id="canvasopen--parallel"></a>

#### `canvas/open` — parallel

A Client opens an episode; providers reconcile durable work before its first view.

```ts cordis-catalog
/**
 * A Client opens an episode; providers reconcile durable work before its first view.
 * @mode parallel
 * @param session - Session that opened the project.
 * @param episode - episode to reconcile.
 */
'canvas/open'(session: Session, episode: EpisodeId): Promise<void>
```

Types: [Session](session.md)

Source: [`packages/media/canvas/src/index.ts`](../../packages/media/canvas/src/index.ts)

<a id="media-events"></a>

### `media/*` events

<a id="mediarender-change--emit"></a>

#### `media/render-change` — emit

A local render changed state; connected renderers can claim queued work.

```ts cordis-catalog
/**
 * A local render changed state; connected renderers can claim queued work.
 * @mode emit
 * @param notice - owner, project, timeline and job state.
 */
'media/render-change'(notice: import('./timeline-render-types.ts').TimelineRenderNotice): void
```

Source: [`packages/media/tool-media/src/types.ts`](../../packages/media/tool-media/src/types.ts)
<!-- END GENERATED cordis-surface -->
