# Agent Note: Conversation-driven canvas

Status: implemented

English | [中文](2026-11-10-conversation-driven-canvas.zh.md)

## Problem

Media tools write generated files into an output directory and return paths. A user who iterates on images and video in one conversation has no place that shows which result came from which inputs, cannot point at "these three pictures" as one unit, and has to repeat file paths to reuse earlier results. The product form is conversation plus canvas: the user talks, and the agent places nodes, connects them, groups them, and feeds nodes or whole groups into the next generation.

## Decision

Each project directory owns one canvas document. `dsh-canvas` is its only writer, the model edits it through two tools, the media tools read inputs from it and place results on it, and a right-Sidebar tab renders it.

### Document

The document is `<project>/.canvas/canvas.json`, where `<project>` is the Session's original directory (`session.header.cwd`), falling back to its current working directory. Sessions opened on the same project share the canvas.

```json
{
  "version": 1,
  "nextId": 4,
  "nodes": [
    { "id": "n1", "type": "image", "title": "Cat", "x": 0, "y": 0, "width": 280, "height": 280, "path": "/abs/cat.png", "group": "g3" },
    { "id": "n2", "type": "text", "title": "Brief", "x": 0, "y": 320, "width": 280, "height": 160, "text": "..." },
    { "id": "g3", "type": "group", "title": "References", "x": -30, "y": -50, "width": 340, "height": 360 }
  ],
  "edges": [{ "id": "g3->n4", "source": "g3", "target": "n4", "kind": "derivation" }]
}
```

Node types are `image`, `video`, `audio`, `text`, and `group`. Ids are short (`n<k>` for content, `g<k>` for groups) because the model repeats them in later calls; `nextId` keeps them unique after removals. Media nodes carry `path`, and generated ones also `prompt` and `model`. A node belongs to at most one group, and groups do not nest. An edge is `derivation` when a generation produced the target from the source, and `reference` when the user or the model drew it.

Writes are serialized per document, validated, and replace the file through a temporary file and rename. A document that fails to parse or validate is never overwritten: reads and edits fail with `canvas/corrupt` until the file is repaired or removed. A missing file is an empty canvas.

### Model tools

`canvas_get` returns nodes, groups with their members, and edges; `nodes` narrows it to named ids and adds full text. `canvas_edit` applies an ordered operation list in one write:

| `op` | Fields | Effect |
|---|---|---|
| `add` | `ref`, `type`, `title`, `path` or `text`, `group` | Create a content node; `ref` names it for later operations in the same call |
| `update` | `node`, `title`, `text`, `path` | Change fields of one node |
| `remove` | `node` | Remove a node with its edges; removing a group keeps its members |
| `connect` / `disconnect` | `from`, `to` | Add or remove one edge |
| `group` | `ref`, `title`, `nodes` | Create a group around existing or just-added nodes |
| `ungroup` | `node` | Dissolve a group and keep its members |

The model never states coordinates. The service lays new nodes out left to right by edge depth beside the nodes they connect to, moves a new node down until it overlaps nothing, never moves a node the user placed, and resizes a group to its members. An operation that names an unknown node, repeats an edge, or would create a cycle is skipped and reported in `skipped` with its reason; the remaining operations still apply, so a node the user deleted mid-turn does not fail the whole call. The result returns the `ref` to id map.

### Nodes and groups as generation inputs

`generate_image` and `generate_video` accept `referenceNodes`, and `generate_video` also `firstFrameNode` and `lastFrameNode`. A node id resolves to that image node's file. A group id resolves to its member image nodes in reading order (top to bottom, then left to right). File-path parameters keep working and are combined with node inputs. A reference that is unknown, is not an image, or is a group with no image fails the call before any gateway request.

After a successful generation the tool adds a node for the written file with the prompt and model, connects one `derivation` edge from every referenced node or group, and returns its id as `nodeId`. A call with `needs_choice` changes nothing. When `dsh-canvas` is not mounted the media tools behave as before and reject node parameters.

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

- Unit specs cover document validation and corrupt-file refusal, every operation with its skip reasons, layout (depth columns, overlap avoidance, placed nodes untouched, group bounds), group resolution order, and the media tools against a fake gateway: a group of two images reaches `/images/edits` as two images, and the result node carries a `derivation` edge from the group.
- The real-gateway run uses the headless profile with a patch that enables `tool-media` against the product gateway and a key supplied only through the environment. It checks three conversations against `canvas.json`: text nodes created, connected, and grouped from one request; two generated images placed and grouped; one image generated from that group, with the edge from the group to the result. The key appears in no log, fixture, or commit.
- The tab is checked in the Web Client on the canvas written by that run: nodes, group frame, and edges render, a dragged node keeps its position after reload, and an agent edit appears without reopening the tab.
