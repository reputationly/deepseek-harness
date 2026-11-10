---
description: "Project canvas document, the canvas_get and canvas_edit model tools, and the canvas Remote namespace."
kind: "package-reference"
---

# @deepseek-ai/dsh-canvas

English | [中文](README.zh.md)

## Summary

Keeps one canvas document per project directory and lets the model, the media tools, and the Web Client work on it. The model places, connects, and groups nodes with `canvas_edit` and reads them with `canvas_get`; `generate_image` and `generate_video` take nodes or whole groups as inputs and place their results back as nodes with derivation edges.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```yaml
- id: canvas
  name: '@deepseek-ai/dsh-canvas'
```

The base bundle ships this row disabled; a deployment enables it together with `tool-media` and the `ui-sidebar-canvas` Client row. The plugin has no configuration.

The document is `<project>/.canvas/canvas.json`, where `<project>` is the Session's original directory. Sessions opened on the same project share it. A missing file is an empty canvas.

Other Host plugins use `ctx.canvas`: `read(session)` returns the document, `edit(session, operations)` applies an operation list in one write, and `resolveImages(session, ids)` turns image nodes and groups into image file paths. A group stands for its image members in reading order: top to bottom, then left to right.

<a id="understand-the-implementation"></a>
## Understand the implementation

`CanvasService` owns the document. Writes are serialized per file, validated, and replace the file through a temporary file and a rename. A file that does not parse or validate is never overwritten: reads and edits fail with `CanvasCorruptError`, and the Remote namespace reports `canvas/corrupt` with the file path.

`applyOperations` applies `add`, `update`, `remove`, `connect`, `disconnect`, `group`, `ungroup`, `move`, and `resize` in order. `ref` names a node created earlier in the same list. An operation that names an unknown node, repeats an edge, would create a cycle, or points at a missing media file is skipped with its reason, and the rest still apply.

The Host lays out new nodes: columns follow edge depth from left to right, a new node moves down until it overlaps nothing, and a group frame is fitted to its members. A node the user moved is marked `placed` and is not laid out again.

The `canvas` Remote namespace exposes `get` and `apply` to the Client, and every write emits the `canvas/change` event with the project directory. The [design note](../../../.agents/notes/implemented/feature/2026-11-10-conversation-driven-canvas.md) records the decisions.

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`canvas_get` and `canvas_edit` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-canvas). `canvas_get` takes an optional `nodes` array of node or group ids. `canvas_edit` takes one `operations` array; each operation names an `op` (`add`, `update`, `remove`, `connect`, `disconnect`, `group`, or `ungroup`) and the fields that operation uses. Neither schema has a coordinate or size field.

#### Token effect

Fixed schema cost on every request where the tools are visible; the descriptions and schemas do not vary with the canvas.

#### KV Cache effect

Prefix-stable while the definitions and their visibility are unchanged.

### Tool-call history and results

#### What the model sees

`canvas_get` returns one line per node, per group with its member ids, and per edge. Text and prompts longer than 160 characters are shortened unless `nodes` names the ids to read in full. `canvas_edit` returns the ids it created beside their `ref` names, and one `Skipped operation <index> (<op>): <reason>.` line for every operation that could not apply. A corrupt document fails either tool with the reason the file was rejected.

#### Token effect

A `canvas_get` result grows with the number of nodes and edges, and with the text length of the nodes read in full. A `canvas_edit` call costs its operation list, and its result grows with the nodes created and the operations skipped.

#### KV Cache effect

Append-only; calls and results follow the reusable request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Edits made in the Client are not Session events; the model sees them on its next `canvas_get`.
- Groups do not nest, and a node belongs to at most one group.
- The document has no backup or migration path yet; `version` is `1`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
