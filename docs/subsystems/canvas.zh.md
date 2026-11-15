# 画布

[English](canvas.md) | 中文

[媒体包族](../../packages/media/README.zh.md)为一个项目目录保存画布文档：每一集一份画布，另有项目元数据与共用设定集。模型通过工具编辑它们，媒体工具把节点读作输入并把结果放回画布，Web Client 在对话旁显示它们。文件归 Host 所有；所有写入方都经过同一个服务。

## 所有权

| 所有者 | 职责 |
|---|---|
| [canvas](../../packages/media/canvas/README.zh.md) | `ctx.canvas`：文档、项目与设定集文件及其校验和原子写入、自动布局、`canvas_*` 与 `studio_*` 工具，以及 `canvas` Remote 命名空间 |
| [tool-media](../../packages/media/tool-media/README.zh.md) | 解析图片、视频和音频节点以供媒体操作使用，并把产物作为带版本和派生边的节点放到画布 |
| [画布标签页 Client](../../packages/client/ui-sidebar-canvas/README.zh.md) | 显示节点、组和边，并把用户的移动、连线、编组和删除发送给 Host |

## 文档与操作

`CanvasDocument` 是一份画布文件的内容——没有元数据时是 `<project>/.canvas/canvas.json`，有 `project.json` 时是它给这一集指定的文件：内容节点（`image`、`video`、`audio`、`text`、`script`、`storyboard`、`timeline`）、组，以及 `reference` 或 `derivation` 类型的边。它带 `version: 3` 和一个每次成功编辑都会推进的 `revision`。格式 1 和 2 在读取时迁移，不重写原文件。文件不存在表示空画布。未通过校验的文件不会被覆盖；格式版本更新时拒绝读取且不写入；读取和编辑会失败并给出原因。

节点内容放在 `versions` 里，`activeVersion` 指向明确采用的版本。生成媒体先作为候选，`set_version` 才会采用，传入 `null` 则清除采用。`activeVersionOf` 不会回退到候选；`previewVersionOf` 可以显示候选而不采用它。版本的 `inputs` 固定来源节点、版本、路径和用途，保护这些来源版本不被历史裁剪删除。分镜版本带 `shots`；音频版本可能带检测出的 `beats` 网格。节点上的 `GenerationSpec` 说明它如何生成：类型、提示词、模型、参数，以及它对应哪几个镜头或哪句台词。

边记录它为下游提供的输入用途：`prompt`、`ref`、`first_frame`、`last_frame`、`audio` 或 `source`；调用方不指定时按两端节点类型推断。派生边是 `<source>-><target>`；参考边是 `<source>-><target>:<role>`，所以一张图可以同时是某个视频的参考图和首帧。参考边用 `order` 记录顺序。

`CanvasOperation` 是一次编辑中的一步：节点操作（`add`、`update`、`remove`、`set_gen`、`set_text`、`set_shots`、`update_shot`、`insert_shot`、`remove_shot`、`move_shot`、`set_version`）、边操作（`connect`、`disconnect`、`reorder_refs`）和布局操作（`group`、`ungroup`、`move`、`resize`）。一次编辑按顺序应用其中的操作，把 `revision` 推进一次，并只写入文件一次；同一次调用里对分镜的多次改写只产生一个版本。无法应用的操作（例如指向未知节点或会形成环的操作）会被跳过并列在 `CanvasEditResult` 中；其余操作照常应用。调用方的 `baseRevision` 过期时，整批调用在写任何内容之前就失败。没有位置的节点按依赖深度布局，用户移动过的节点保持原位。

`project.json` 保存题材、分集列表，以及决定会话编辑哪一集的绑定；`bible.json` 保存共用风格、角色、场景和道具，提示词用 `@名字` 引用它们。两者各有自己的 revision，由存储在每次写入时推进。

`CanvasView` 是 Remote 调用方收到的文档，连同项目目录、分集和各文件的 revision。每次成功的编辑都会发出 `canvas/change`，其中的 `CanvasChange` 指明该目录、分集，以及这次写过的每个文件的 revision；Remote 命名空间会把它转发给已连接的 Client。

<a id="timelines"></a>

## 时间线

每个时间线节点拥有 `<canvas-file>.timelines/<node>.json`，不可变快照保存在 `<timeline-file>.history/<revision>.json`。`timelineHistoryLimit` 限制保留的历史窗口，默认 100。Host 先归档并校验上一修订，再替换当前文件；归档或清理失败时，当前修订保持不变。当前片段和保留的历史片段都会保护其来源版本，阻止版本清理和来源节点删除。

`timeline_get`、`timeline_edit`、`timeline_history`、`timeline_restore` 都要求显式传入 `node`、`episode`、`directory` 绑定。项目已切换或分集不存在时，Host 在写入前拒绝操作。`timeline_restore` 还要求传入已核对的 `baseRevision`，并指定 `restore`、`undo` 或 `redo` 模式。恢复通过共享操作写成新修订。Host 管理的 `Timeline.history` 持久化撤销与重做游标；`TimelineRevision.undo`、`.redo` 只公布保留窗口内仍可读取的目标。普通编辑或显式恢复清除重做分支。历史缺失或修订冲突后，必须重新读取并明确核对，不会静默覆盖草稿。

`Timeline` 拥有独立的 `revision`、包含偶数输出尺寸和 24/25/30 帧率的 `spec`，以及按顺序排列的 `TimelineTrack` 图层。轨道类型为 `video`、`audio` 和 `text`。`TimelineClip` 用整数 `startMs`、`durationMs` 定义包含起点、不含终点的区间。媒体来源固定 `node`、`version` 和 `inMs`。视频轨接受图片或视频，音频轨接受音频或视频，文本轨存放字幕。入点加片段时长不能超过已知素材时长。未知字段或无效文档会被拒绝，原文件保持不变。

`TimelineOperation` 整批原子提交，并要求调用方提供 `baseRevision`。操作涵盖轨道与片段的增删、移动、裁剪、分割、波纹删除、片段与轨道参数修改以及输出规格调整。分割保留素材偏移并清除右片段的入场转场；波纹删除移动同轨后续片段。成功的非空批次推进时间线 revision；`TimelineEditResult.invalidated` 合并修改前后受影响的区间。画布 revision 独立管理。

客户端可用的合成器对预览与编码求值同一份文档。视频与字幕按文档顺序绘制；静音轨道不输出画面和声音。字幕共用字素换行、字体、颜色、描边、字号和位置规则。变换使用输出像素及角度。`dissolve` 让入场图层在可见图层上渐显；两个运动片段交叉溶解时需要重叠。`fade_black` 先填充变换区域再渐显。图片运镜覆盖片段时长。音频按素材入点、轨道与片段音量、线性淡入淡出混合，最后统一限幅。独立求值 PCM 分块不改变采样位置；可见媒体缺失时禁止发布该帧。

## 媒体输入

`resolveImages` 把节点 id 转换为供媒体生成使用的图片文件路径。图片节点代表它的文件。组代表其中的图片成员，按阅读顺序排列：先从上到下，再从左到右。其他节点类型、未知 id 或不含图片的组，都会在调用网关之前失败。

`resolveMedia` 按输入顺序把图片、视频和音频节点 id 转换为供剪辑和探测使用的文件路径。它会对组、文本节点、没有路径的节点和未知 id 抛出 `CanvasInputError`；`resolveImages` 保持原有的图片和组行为。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Session](session.zh.md)

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

Types: [Session](session.zh.md)

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
