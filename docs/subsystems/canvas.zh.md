# 画布

[English](canvas.md) | 中文

[媒体包族](../../packages/media/README.zh.md)为每个项目目录保存一份画布文档。模型通过工具编辑它，媒体工具把节点读作输入并把结果放回画布，Web Client 在对话旁显示它。文档归 Host 所有；所有写入方都经过同一个服务。

## 所有权

| 所有者 | 职责 |
|---|---|
| [canvas](../../packages/media/canvas/README.zh.md) | `ctx.canvas`：文档及其校验和原子写入、自动布局、`canvas_get` 和 `canvas_edit` 工具，以及 `canvas` Remote 命名空间 |
| [tool-media](../../packages/media/tool-media/README.zh.md) | 把画布节点和组解析为生成输入，并把每个结果作为带派生边的节点放回画布 |
| [画布标签页 Client](../../packages/client/ui-sidebar-canvas/README.zh.md) | 显示节点、组和边，并把用户的移动、连线、编组和删除发送给 Host |

## 文档与操作

`CanvasDocument` 是 `<project>/.canvas/canvas.json` 的内容：内容节点（`image`、`video`、`audio`、`text`）、组，以及 `reference` 或 `derivation` 类型的边。文件不存在表示空画布。未通过校验的文件不会被覆盖；读取和编辑会失败并给出原因。

`CanvasOperation` 是一次编辑中的一步：`add`、`update`、`remove`、`connect`、`disconnect`、`group`、`ungroup`、`move` 或 `resize`。一次编辑按顺序应用其中的操作，并只写入文件一次。无法应用的操作（例如指向未知节点或会形成环的操作）会被跳过并列在 `CanvasEditResult` 中；其余操作照常应用。没有位置的节点按依赖深度布局，用户移动过的节点保持原位。

`CanvasView` 是 Remote 调用方收到的文档及其项目目录。每次成功的编辑都会发出 `canvas/change`，其中的 `CanvasChange` 指明该目录，Remote 命名空间会把它转发给已连接的 Client。

## 生成输入

`resolveImages` 把节点 id 转换为媒体工具使用的图片文件路径。图片节点代表它的文件。组代表其中的图片成员，按阅读顺序排列：先从上到下，再从左到右。其他节点类型、未知 id 或不含图片的组，都会在调用网关之前失败。

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
read(session: Session): Promise<CanvasDocument>

/**
 * Apply operations to the canvas of a Session's project in one write.
 * @param session - Session opened on the project.
 * @param operations - ordered operations; relative media paths resolve against the project directory.
 * @returns assigned ids and the operations that were skipped with their reasons.
 * @throws `CanvasCorruptError` when the canvas file is not a valid document.
 */
async edit(session: Session, operations: readonly CanvasOperation[]): Promise<CanvasEditResult>

/**
 * Resolve nodes and groups to the image files they stand for as generation inputs.
 * @param session - Session opened on the project.
 * @param ids - image node ids or group ids; a group stands for its image members in reading order (top to bottom, then left to right).
 * @returns absolute image paths in input order, without duplicates.
 * @throws {@link CanvasInputError} when an id is unknown, is not an image or group, or is a group without images.
 */
async resolveImages(session: Session, ids: readonly string[]): Promise<string[]>

/**
 * Read the canvas shown for a Session.
 * @param session - Session opened on the project.
 * @returns the project directory and its canvas document.
 * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
 */
@Remote('get') async get(session: Session): Promise<CanvasView>

/**
 * Apply a user's edits to the canvas shown for a Session.
 * @param session - Session opened on the project.
 * @param operations - ordered operations.
 * @returns assigned ids and the operations that were skipped with their reasons.
 * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
 */
@Remote('apply') apply(session: Session, operations: CanvasOperation[]): Promise<CanvasEditResult>
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
