---
description: "Project canvas document, its episodes, project and bible files, and the canvas_get, canvas_edit, and studio_* model tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-canvas

English | [中文](README.zh.md)

## Summary

Keeps the canvas documents of one project directory and lets the model, the media tools, and the Web Client work on them. A project holds one canvas file per episode plus `project.json` (format, episodes, Session bindings) and `bible.json` (shared style, characters, locations, props). Nodes carry versions with an active version, edges carry the role of the input they supply, and every successful edit bumps the document revision the caller must present before writing again.

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
  config:
    versionLimit: 8
```

The base bundle ships this row disabled; a deployment enables it together with `tool-media` and the `ui-sidebar-canvas` Client row.

| Config field | Default | Meaning |
|:--|:--|:--|
| `maxNodes` | 10000 | Largest number of nodes one canvas may hold. |
| `maxEdges` | 20000 | Largest number of edges one canvas may hold. |
| `maxPromptLength` | 20000 | Longest prompt accepted on one node, in characters. |
| `maxBatchOperations` | 64 | Largest number of operations one `canvas_edit` call may carry. |
| `versionLimit` | 8 | Versions kept per media node. |
| `textVersionLimit` | 20 | Versions kept per text, script, and storyboard node. |
| `maxShotsPerStoryboard` | 24 | Largest number of shots one storyboard may hold. |
| `journalLimit` | 200 | Edits kept in an episode's undo journal. |

The files are `<project>/.canvas/canvas.json` (the canvas of episode `e1` of a project without `project.json`, or of whichever episode names it), `project.json`, `bible.json`, and one file per further episode under `.canvas/episodes/`. A missing file means the default: no canvas nodes, no project metadata, an empty bible.

Other Host plugins use `ctx.canvas`: `read(session, episode?)` returns a document, `edit(session, operations, { baseRevision, episode, origin })` applies a list in one write, `resolveImages` and `resolveMedia` turn nodes into file paths, `bibleOf`, `updateBible`, `createProject`, `createEpisode`, and `useEpisode` manage the project-level files, and `activeVersionOf(node)` returns the version a node shows.

<a id="understand-the-implementation"></a>
## Understand the implementation

`CanvasService` resolves the target of a Session: its directory, its project metadata, and the episode it is bound to (`project.json` bindings, else the first episode). `CanvasStore` serializes every write of one project directory through one lock, so an edit that touches the canvas and a project-level file lands as one step, and each rewrite replaces its file through a temporary file and a rename. A file that does not parse or validate is never overwritten: reads and edits fail with `CanvasCorruptError`, a newer format fails with `CanvasUnsupportedVersionError`, and the Remote namespace reports `canvas/corrupt` or `canvas/unsupported-version` with the file path.

A version-1 canvas migrates on read: node content becomes version `v1`, reference edges take the role their node kinds imply, and the next write persists version 2.

`applyOperations` applies `add`, `update`, `remove`, `set_gen`, `set_text`, `set_shots`, `update_shot`, `insert_shot`, `remove_shot`, `move_shot`, `set_version`, `connect`, `disconnect`, `reorder_refs`, `group`, `ungroup`, `move`, and `resize` in order, then advances `revision` once. Host-side generation writes use `append_version`, `set_status`, `set_stale`, and `set_tail`; the model-facing `canvas_edit` schema does not expose them. An `add` whose node names generation but no file creates a pending node, so a job can fill it later.

`planShotSegments` splits a storyboard into generation segments: a segment may only start on a cut point (scene change, new character, close shot), a run of continuation shots stays together, and a segment that must continue the previous picture is marked `needsTailChain`. The same function feeds the budget quote and the runner, so a quote cannot disagree with the work. `production.ts` holds the stage order, the stage-advance rules, and the `G1`/`G2` gates over the bible and storyboard; `production.json` records each episode's stage and the gate overrides a user granted. A scene group records the script and scene it was laid out from as `sceneOrigin`, which `studio_expand_script` uses to avoid laying the same scene out twice. `ref` names a node created earlier in the same list. Shot rewrites inside one call produce one version. An operation that names an unknown node or shot, repeats an edge or a role, would create a cycle, or carries content its node kind cannot hold is skipped with its reason, and the rest still apply.

Edges are keyed by role: a derivation edge is `<source>-><target>`, a reference edge is `<source>-><target>:<role>`, so one image can be both a reference and the first frame of one video. Reference order is the `order` field, and `reorder_refs` rewrites it.

The Host lays out new nodes: columns follow edge depth from left to right, a new node moves down until it overlaps nothing, and a group frame is fitted to its members. A node the user moved is marked `placed` and is not laid out again.

The `canvas` Remote namespace exposes `get` and `apply`; every write emits `canvas/change` with the project directory, the episode, and the revision of each file it wrote. The [design note](../../../.agents/notes/implemented/feature/2026-11-10-conversation-driven-canvas.md) records the decisions behind the conversation-driven canvas.

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`canvas_get`, `canvas_edit`, and `studio_*` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-canvas). `canvas_get` takes optional `nodes`, `detail` (`summary` or `full`), and `include` (`bible`, `project`). `canvas_edit` takes one `operations` array and a required `baseRevision`. `studio_project_create`, `studio_episode_create`, `studio_episode_use`, `studio_bible_update`, and `studio_expand_script` create the project, its episodes, its bible, and the scene layout of a script. No schema has a coordinate or size field.

#### Token effect

Fixed schema cost on every request where the tools are visible; the definitions do not vary with the canvas.

#### KV Cache effect

Prefix-stable while the definitions and their visibility are unchanged.

### Tool-call history and results

#### What the model sees

`canvas_get` returns a header line with the revision, episode, and whether project and bible files exist, then one line per node, per group with its member ids, and per edge. Long text and prompts are shortened in `summary` unless `nodes` names the ids to read. `detail: full` keeps them and adds each storyboard's shots; `include` adds the project or bible JSON. `canvas_edit` returns the new revision, the ids it created beside their `ref` names, and one `Skipped operation <index> (<op>): <reason>.` line per operation that could not apply. A stale `baseRevision` fails the call with `canvas: revision is <actual>, not the <expected> this edit was based on`.

#### Token effect

A `canvas_get` result grows with the number of nodes and edges, the text of nodes read in full, the shots of storyboards, and the project or bible JSON. A `canvas_edit` call costs its operation list, and its result grows with the nodes created and operations skipped.

#### KV Cache effect

Append-only; calls and results follow the reusable request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Edits made in the Client are not Session events; the model sees them on its next `canvas_get`.
- Groups do not nest, and a node belongs to at most one group.
- Undo and redo (`journalLimit`) and the timeline node's tools arrive with later phases of the [studio spec](../../../docs/suanli-canvas-studio-spec.md); `production.json` is specified but not yet written.
- Storyboard segmentation and the generation runner live in `tool-media`; this package only stores shots.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
