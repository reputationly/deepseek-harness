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

`CanvasDocument` 是一份画布文件的内容——没有元数据时是 `<project>/.canvas/canvas.json`，有 `project.json` 时是它给这一集指定的文件：内容节点（`image`、`video`、`audio`、`text`、`script`、`storyboard`、`timeline`）、组，以及 `reference` 或 `derivation` 类型的边。它带 `version: 2` 和一个每次成功编辑都会推进的 `revision`。文件不存在表示空画布。未通过校验的文件不会被覆盖；格式版本更新时拒绝读取且不写入；读取和编辑会失败并给出原因。

节点内容放在 `versions` 里，由 `activeVersion` 指向当前版本；`activeVersionOf` 返回节点展示的版本，缺失时回退到最新的一个。分镜版本带 `shots`；音频版本可能带检测出的 `beats` 网格。节点上的 `GenerationSpec` 说明它如何生成：类型、提示词、模型、参数，以及它对应哪几个镜头或哪句台词。

边记录它为下游提供的输入用途：`prompt`、`ref`、`first_frame`、`last_frame`、`audio` 或 `source`；调用方不指定时按两端节点类型推断。派生边是 `<source>-><target>`；参考边是 `<source>-><target>:<role>`，所以一张图可以同时是某个视频的参考图和首帧。参考边用 `order` 记录顺序。

`CanvasOperation` 是一次编辑中的一步：节点操作（`add`、`update`、`remove`、`set_gen`、`set_text`、`set_shots`、`update_shot`、`insert_shot`、`remove_shot`、`move_shot`、`set_version`）、边操作（`connect`、`disconnect`、`reorder_refs`）和布局操作（`group`、`ungroup`、`move`、`resize`）。一次编辑按顺序应用其中的操作，把 `revision` 推进一次，并只写入文件一次；同一次调用里对分镜的多次改写只产生一个版本。无法应用的操作（例如指向未知节点或会形成环的操作）会被跳过并列在 `CanvasEditResult` 中；其余操作照常应用。调用方的 `baseRevision` 过期时，整批调用在写任何内容之前就失败。没有位置的节点按依赖深度布局，用户移动过的节点保持原位。

`project.json` 保存题材、分集列表，以及决定会话编辑哪一集的绑定；`bible.json` 保存共用风格、角色、场景和道具，提示词用 `@名字` 引用它们。两者各有自己的 revision，由存储在每次写入时推进。

`CanvasView` 是 Remote 调用方收到的文档，连同项目目录、分集和各文件的 revision。每次成功的编辑都会发出 `canvas/change`，其中的 `CanvasChange` 指明该目录、分集，以及这次写过的每个文件的 revision；Remote 命名空间会把它转发给已连接的 Client。

## 媒体输入

`resolveImages` 把节点 id 转换为供媒体生成使用的图片文件路径。图片节点代表它的文件。组代表其中的图片成员，按阅读顺序排列：先从上到下，再从左到右。其他节点类型、未知 id 或不含图片的组，都会在调用网关之前失败。

`resolveMedia` 按输入顺序把图片、视频和音频节点 id 转换为供剪辑和探测使用的文件路径。它会对组、文本节点、没有路径的节点和未知 id 抛出 `CanvasInputError`；`resolveImages` 保持原有的图片和组行为。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcanvas--canvasservice"></a>

### `ctx.canvas` — `CanvasService`

Owns every project's canvas document.

```ts cordis-catalog
/**
 * Project directory whose canvas a Session edits.
 * @param session - Session opened on the project.
 * @returns the Session's original directory, or its current one when the header records none.
 */
directoryOf(session: Session): string

/**
 * Read the canvas of a Session's project.
 * @param session - Session opened on the project.
 * @returns the validated document; an empty canvas when the project has none.
 * @throws `CanvasCorruptError` when the canvas file is not a valid document.
 */
async read(session: Session, episode?: EpisodeId): Promise<CanvasDocument>

/**
 * Apply operations to the canvas of a Session's project in one write.
 * @param session - Session opened on the project.
 * @param operations - ordered operations; relative media paths resolve against the project directory.
 * @returns assigned ids and the operations that were skipped with their reasons.
 * @throws `CanvasCorruptError` when the canvas file is not a valid document.
 */
async edit(session: Session, operations: readonly CanvasOperation[], options?: { readonly baseRevision?: number; readonly episode?: EpisodeId; readonly origin?: 'agent' | 'user' }): Promise<CanvasEditResult>

/**
 * Resolve nodes and groups to the image files they stand for as generation inputs.
 * @param session - Session opened on the project.
 * @param ids - image node ids or group ids; a group stands for its image members in reading order (top to bottom, then left to right).
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
async projectOf(session: Session): Promise<{ readonly project: StudioProject | undefined; readonly revision: number; readonly current: CanvasEpisode; readonly episodes: readonly CanvasEpisode[] }>

/**
 * Read the bible of a Session's project.
 * @param session - Session opened on the project.
 * @returns the bible, or an empty one when the project has none, with the revision the file holds.
 */
async bibleOf(session: Session): Promise<{ readonly bible: Bible; readonly revision: number }>

/**
 * Bible entries the storyboards of every episode of a project reference.
 * @param session - Session opened on the project.
 * @returns the referencing storyboard nodes per entry id.
 */
async bibleReferences(session: Session): Promise<ReadonlyMap<BibleEntryId, readonly string[]>>

/**
 * Create the project metadata, making the existing single canvas its first episode.
 * @param session - Session opened on the project.
 * @param request - production format, title, and output specification.
 * @returns the project after the write and its revision.
 */
async createProject(session: Session, request: { readonly format: ProductionFormat; readonly title: string; readonly spec: ProjectSpec }): Promise<{ readonly project: StudioProject; readonly revision: number }>

/**
 * Add an episode to the project.
 * @param session - Session opened on the project.
 * @param title - title of the new episode.
 * @returns the new episode and the project revision.
 */
async createEpisode(session: Session, title: string): Promise<{ readonly episode: CanvasEpisode; readonly revision: number }>

/**
 * Bind a Session to an episode.
 * @param session - Session opened on the project.
 * @param episode - episode the Session edits.
 * @returns the project revision after the binding.
 */
async useEpisode(session: Session, episode: EpisodeId): Promise<{ readonly revision: number }>

/**
 * Update the bible of a Session's project.
 * @param session - Session opened on the project.
 * @param change - fields to replace, entries to upsert, and entries to remove.
 * @param baseRevision - bible revision the caller read, or undefined to skip the check.
 * @returns the bible after the write and its revision.
 */
async updateBible(session: Session, change: { readonly logline?: string | undefined; readonly style?: Partial<Bible['style']> | undefined; readonly upsert?: readonly BibleEntry[] | undefined; readonly remove?: readonly BibleEntryId[] | undefined }, baseRevision?: number): Promise<{ readonly bible: Bible; readonly revision: number }>

/**
 * Read the canvas shown for a Session.
 * @param session - Session opened on the project.
 * @returns the project directory and its canvas document.
 * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
 */
@Remote('get') async get(session: Session, episode?: EpisodeId): Promise<CanvasView>

/**
 * Apply a user's edits to the canvas shown for a Session.
 * @param session - Session opened on the project.
 * @param operations - ordered operations.
 * @returns assigned ids and the operations that were skipped with their reasons.
 * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
 */
@Remote('apply') apply(session: Session, operations: CanvasOperation[], baseRevision: number, episode?: EpisodeId): Promise<CanvasEditResult>
```

Types: [Session](session.zh.md)

Source: [`packages/media/canvas/src/index.ts`](../../packages/media/canvas/src/index.ts)

<a id="canvas-events"></a>

### `canvas/*` events

<a id="canvaschange--emit"></a>

#### `canvas/change` — emit

A project's canvas document was rewritten.

```ts cordis-catalog
/**
 * A project's canvas document was rewritten.
 * @mode emit
 * @param change - the project directory whose canvas changed.
 */
'canvas/change'(change: CanvasChange): void
```

Source: [`packages/media/canvas/src/types.ts`](../../packages/media/canvas/src/types.ts)
<!-- END GENERATED cordis-surface -->
