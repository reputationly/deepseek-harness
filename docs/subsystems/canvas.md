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

`CanvasDocument` is the content of one canvas file — `<project>/.canvas/canvas.json` for a project without metadata, or the file `project.json` names for an episode: content nodes (`image`, `video`, `audio`, `text`, `script`, `storyboard`, `timeline`), groups, and edges of kind `reference` or `derivation`. It carries `version: 2` and a `revision` that every successful edit advances. A missing file is an empty canvas. A file that fails validation is never overwritten; a newer format version is refused without writing; reads and edits fail with the reason instead.

Node content lives in `versions` with an `activeVersion`; `activeVersionOf` returns the version a node shows, falling back to its newest one. A storyboard version holds `shots`; an audio version may hold a detected `beats` grid. `GenerationSpec` on a node says how it generates: kind, prompt, model, parameters, and which shots or dialogue line it belongs to.

Edges carry the role of the input they supply: `prompt`, `ref`, `first_frame`, `last_frame`, `audio`, or `source`, inferred from node kinds when the caller names none. A derivation edge is `<source>-><target>`; a reference edge is `<source>-><target>:<role>`, so one image can be both a reference and the first frame of one video. References keep their `order`.

`CanvasOperation` is one step of an edit: the node operations (`add`, `update`, `remove`, `set_gen`, `set_text`, `set_shots`, `update_shot`, `insert_shot`, `remove_shot`, `move_shot`, `set_version`), the edge operations (`connect`, `disconnect`, `reorder_refs`), and the layout operations (`group`, `ungroup`, `move`, `resize`). One edit applies its operations in order, advances `revision` once, and writes the file once; a shot rewrite inside one call produces one version. An operation that cannot apply, such as one naming an unknown node or closing a cycle, is skipped and listed in `CanvasEditResult`; the others still apply. A caller's stale `baseRevision` fails the whole call before anything is written. Nodes without a position are laid out by dependency depth, and nodes the user moved stay where they are.

`project.json` holds the production format, the episode list, and the Session bindings that decide which episode a Session edits; `bible.json` holds the shared style, characters, locations, and props that prompts reference as `@name`. Both carry their own revision, advanced by the store on every write.

`CanvasView` is the document a Remote caller receives together with its project directory, episode, and file revisions. Each successful edit emits `canvas/change` with a `CanvasChange` naming that directory, the episode, and the revision of each file it wrote; the Remote namespace forwards it to connected Clients.

## Media inputs

`resolveImages` turns node ids into image file paths for generation. An image node stands for its file. A group stands for its image members in reading order, top to bottom and then left to right. Any other node type, an unknown id, or a group without an image fails before the gateway is called.

`resolveMedia` turns image, video, and audio node ids into file paths in input order for editing and probing. It rejects groups, text nodes, nodes without paths, and unknown ids with `CanvasInputError`; `resolveImages` keeps its image and group behavior.

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
