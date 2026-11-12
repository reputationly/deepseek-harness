# Agent Note: Conversation-driven canvas

Status: implemented

English | [中文](2026-11-10-conversation-driven-canvas.zh.md)

## Problem

Media tools write generated files into an output directory and return paths. A user who iterates on images and video in one conversation has no place that shows which result came from which inputs, cannot point at "these three pictures" as one unit, and has to repeat file paths to reuse earlier results. The product form is conversation plus canvas: the user talks, and the agent places nodes, connects them, groups them, and feeds nodes or whole groups into the next generation.

## Decision

A project directory owns one canvas per episode, plus project metadata and a shared bible. `dsh-canvas` is their only writer, the model edits them through the canvas and studio tools, the media tools read inputs from them and place results on them, and a right-Sidebar tab renders the canvas.

### Documents

`<project>/.canvas/canvas.json` is the canvas of episode 1 when the project has no `project.json`; with one, `project.json` names the file of every episode (`episodes/<id>.json` for the rest) and records which episode each Session edits. `<project>` is the Session's original directory (`session.header.cwd`), falling back to its current working directory. `bible.json` holds the shared style, characters, locations, and props.

```json
{
  "version": 2,
  "revision": 3,
  "nextId": 4,
  "nodes": [
    { "id": "n1", "type": "image", "title": "Cat", "x": 0, "y": 0, "width": 280, "height": 280, "group": "g3", "activeVersion": "v1",
      "versions": [{ "id": "v1", "path": "/abs/cat.png", "prompt": "a cat", "model": "qwen-image-pro", "createdAt": "…", "origin": "agent" }] },
    { "id": "n2", "type": "text", "title": "Brief", "x": 0, "y": 320, "width": 280, "height": 160,
      "versions": [{ "id": "v1", "text": "…", "createdAt": "…", "origin": "user" }] }
  ],
  "edges": [
    { "id": "n1->n4:ref", "source": "n1", "target": "n4", "kind": "reference", "role": "ref", "order": 0 },
    { "id": "g3->n4", "source": "g3", "target": "n4", "kind": "derivation" }
  ]
}
```

Node types are `image`, `video`, `audio`, `text`, `script`, `storyboard`, `timeline`, and `group`. Ids are short (`n<k>` for content, `g<k>` for groups) because the model repeats them in later calls; `nextId` keeps them unique after removals. Content lives in `versions`, which the version limits bound without ever dropping the active one; a `storyboard` version holds shots, and an audio version may hold a detected `beats` grid. `gen` says how a media node generates, including which shots or dialogue line it stands for. A node belongs to at most one group, and groups do not nest.

An edge records what it supplies: `derivation` when a generation produced the target from the source, `reference` with a `role` (`prompt`, `ref`, `first_frame`, `last_frame`, `audio`, `source`) when it feeds an input. Reference edges are keyed by role, so one image can be both a reference and the first frame of one video.

`revision` advances once per successful edit, and every writer states the revision it read; a stale one fails the whole call before anything is written, which is what keeps two Sessions on one episode from overwriting each other. `project.json`, `bible.json`, and the canvas all carry their own revision, advanced by the store on each write.

Writes are serialized per project directory, validated, and replace each file through a temporary file and rename. A document that fails to parse or validate is never overwritten: reads and edits fail with `canvas/corrupt`, and a newer format version is refused with `canvas/unsupported-version`, until the file is repaired or removed. A version-1 canvas migrates on read. A missing file is an empty canvas.

### Model tools

`canvas_get` returns the revision, the episode, whether `project.json` and `bible.json` exist, nodes, groups with their members, and edges; `nodes` narrows it to named ids, `detail: full` keeps long text and adds storyboard shots, and `include` adds the project or bible JSON. `canvas_edit` applies an ordered operation list in one write and requires the `baseRevision` that `canvas_get` returned:

| `op` | Fields | Effect |
|---|---|---|
| `add` | `ref`, `type`, `title`, `path`/`text`/`shots`, `gen`, `bible`, `group` | Create a content node with its first version; `ref` names it for later operations in the same call |
| `update` | `node`, `title`, `text`, `path` | Change fields of one node; text and path changes add a version |
| `remove` | `node` | Remove a node with its edges; removing a group keeps its members |
| `set_gen` | `node`, `gen` | Change generation parameters; a `null` value deletes one |
| `set_text` / `set_shots` | `node`, `text`/`shots` | Store one new version |
| `update_shot` / `insert_shot` / `remove_shot` / `move_shot` | `node`, `shot`, patch or `after` | Edit one shot of a storyboard; one call adds at most one version |
| `set_version` | `node`, `version` | Switch the version the node shows |
| `connect` / `disconnect` | `from`, `to`, optional `role` | Add or remove one edge; dropping `role` removes every edge between the two nodes |
| `reorder_refs` | `node`, `sources` | Rewrite the reference order |
| `group` / `ungroup` | `ref`, `title`, `nodes` / `node` | Create a group around nodes, or dissolve one and keep its members |

`studio_project_create`, `studio_episode_create`, `studio_episode_use`, `studio_bible_update`, and `studio_expand_script` create the project, its episodes, its bible entries, and one group per scene of a script; `studio_bible_update` refuses to delete an entry a storyboard still uses.

The model never states coordinates. The service lays new nodes out left to right by edge depth beside the nodes they connect to, moves a new node down until it overlaps nothing, never moves a node the user placed, and resizes a group to its members. An operation that names an unknown node, repeats an edge, or would create a cycle is skipped and reported in `skipped` with its reason; the remaining operations still apply, so a node the user deleted mid-turn does not fail the whole call. The result returns the `ref` to id map.

### Nodes and groups as generation inputs

`generate_image` and `generate_video` accept `referenceNodes`, and `generate_video` also `firstFrameNode` and `lastFrameNode`. A node id resolves to that image node's file. A group id resolves to its member image nodes in reading order (top to bottom, then left to right). File-path parameters keep working and are combined with node inputs. A reference that is unknown, is not an image, or is a group with no image fails the call before any gateway request.

After a successful generation the tool adds a node whose first version holds the written file with the prompt and model, sets `gen` to what produced it, connects one `derivation` edge from every referenced node or group, and returns its id as `nodeId`. A canvas write from `tool-media` states the revision it read and follows the same conflict rule as the model tools. A call with `needs_choice` changes nothing. When `dsh-canvas` is not mounted the media tools behave as before and reject node parameters.

### Remote API and Sidebar tab

`CanvasService` exposes the `canvas` Remote namespace: `get` reads the document, `apply` applies user edits (the model operations plus `move` and `resize`), and the `canvas/change` Remote event tells Clients to reload. The canvas tab in `dsh-client-ui-sidebar-canvas` renders the document with `@xyflow/react`: media and text cards, group frames, edges, minimap, zoom controls, drag to move, connect by dragging between handles, and delete. Image bytes load through `workspaceFiles.readBytes`. A node the user moved is marked `placed`, which is what layout respects.

## Alternatives considered

- **Port the canvas renderer from the internal design tool.** Rejected: it targets React 19 with a forked flow library and reproduces another product's interface; this Client is React 18 with locale-owned copy and its own visual language. Its document shape, write safety, and host-places-results rule are kept.
- **A whiteboard library (Excalidraw, tldraw).** Rejected: free-form shapes do not model "this result derives from those inputs", and tldraw's license restricts production use. `@xyflow/react` is MIT and node-and-edge native.
- **One tool per operation.** Rejected: building a five-node graph would cost a dozen model turns and leave half-built canvases on failure. One operation list with call-local refs is one turn and one write.
- **Let the model pass file paths for group members.** Rejected: it must first read the canvas, copy paths, and keep them in order, and the derivation edges are lost. Resolving ids on the Host keeps the group the unit the user named.
- **Store the canvas in the Session log.** Rejected: the canvas belongs to the project and outlives a conversation; a plain file is also what the user can back up or hand to another tool.

## Consequences

- The model reuses earlier results by id and the canvas records where each result came from, at the cost of one more document format to keep compatible.
- Layout is deterministic and Host-owned, so replaying the same operations gives the same canvas; the model cannot request a specific arrangement.
- Sessions on one project share a canvas; concurrent edits serialize, and the last write to one field wins.
- User edits in the tab are not Session events, so the model learns of them only on its next `canvas_get`.

## Testing

- Unit specs cover document validation, the version-1 migration, corrupt and newer-version refusal, deployment bounds, every operation with its skip reasons and revision conflict, layout (depth columns, overlap avoidance, placed nodes untouched, group bounds), role inference and role-keyed edges, project and bible parsing with their revision guards, group resolution order, and the media tools against a fake gateway: a group of two images reaches `/images/edits` as two images, and the result node carries a `derivation` edge from the group and a version with the written path.
- The real-gateway run uses the headless profile with a patch that enables `tool-media` against the product gateway and a key supplied only through the environment. It checks three conversations against `canvas.json`: text nodes created, connected, and grouped from one request; two generated images placed and grouped; one image generated from that group, with the edge from the group to the result. The key appears in no log, fixture, or commit.
- The tab is checked in the Web Client on the canvas written by that run: nodes, group frame, and edges render, a dragged node keeps its position after reload, and an agent edit appears without reopening the tab.
