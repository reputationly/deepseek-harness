---
kind: upgrade-guide
description: "`canvas.json` moves to format version 2 with node versions, reference roles, and a document revision."
---

# Canvas files move to format version 2

English | [中文](guide.zh.md)

## Change

`<project>/.canvas/canvas.json` now declares `version: 2` and carries `revision`. A node's content lives in `versions` with an `activeVersion`; edges carry a `role` (`prompt`, `ref`, `first_frame`, `last_frame`, `audio`, `source`) and, for references, an `order`. A project may also hold `.canvas/project.json` naming one canvas file per episode.

A build that reads version 1 migrates the file in memory and writes version 2 on the next edit; a build older than this release refuses a version-2 canvas and leaves the file untouched. Anyone reading the file directly, pinning its shape, or running an older build against the same project is affected.

## Migration

1. Upgrade every node that reads or writes `.canvas/canvas.json` to this release; do not run an older build on a project a newer build has edited.
2. Read node content from the active version: `canvas.json` no longer has top-level `path`, `text`, `prompt`, or `model` on a node. `activeVersionOf(node)` in `@deepseek-ai/dsh-canvas` returns the version the canvas shows.
3. Address edges by role: a reference edge id is `<source>-><target>:<role>`, a derivation edge keeps `<source>-><target>`.
4. Pass a base revision when writing. `canvas_edit` requires `baseRevision`; a stale one is refused with `canvas: revision is <actual>, not the <expected> this edit was based on`.
5. Confirm by opening the project: `canvas_get` reports `Revision <n> · episode e1`, and the file starts with `"version": 2`.
