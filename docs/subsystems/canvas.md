# Canvas

English | [中文](canvas.zh.md)

The [media package family](../../packages/media/README.md) keeps one canvas document per project directory. The model edits it through tools, the media tools read nodes as inputs and place results on it, and the Web Client shows it beside the conversation. The Host owns the document; every writer goes through the same service.

## Ownership

| Owner | Responsibility |
|---|---|
| [canvas](../../packages/media/canvas/README.md) | `ctx.canvas`: the document, its validation and atomic writes, automatic layout, the `canvas_get` and `canvas_edit` tools, and the `canvas` Remote namespace |
| [tool-media](../../packages/media/tool-media/README.md) | Resolves canvas nodes and groups into generation inputs and places each result as a node with derivation edges |
| [Canvas tab Client](../../packages/client/ui-sidebar-canvas/README.md) | Shows nodes, groups, and edges, and sends the user's moves, connections, grouping, and deletions to the Host |

## Document and operations

`CanvasDocument` is the content of `<project>/.canvas/canvas.json`: content nodes (`image`, `video`, `audio`, `text`), groups, and edges of kind `reference` or `derivation`. A missing file is an empty canvas. A file that fails validation is never overwritten; reads and edits fail with the reason instead.

`CanvasOperation` is one step of an edit: `add`, `update`, `remove`, `connect`, `disconnect`, `group`, `ungroup`, `move`, or `resize`. One edit applies its operations in order and writes the file once. An operation that cannot apply, such as one naming an unknown node or closing a cycle, is skipped and listed in `CanvasEditResult`; the others still apply. Nodes without a position are laid out by dependency depth, and nodes the user moved stay where they are.

`CanvasView` is the document a Remote caller receives together with its project directory. Each successful edit emits `canvas/change` with a `CanvasChange` naming that directory, and the Remote namespace forwards it to connected Clients.

## Generation inputs

`resolveImages` turns node ids into image file paths for the media tools. An image node stands for its file. A group stands for its image members in reading order, top to bottom and then left to right. Any other node type, an unknown id, or a group without an image fails before the gateway is called.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Session](session.md)

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
