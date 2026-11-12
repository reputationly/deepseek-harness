---
kind: upgrade-guide
description: "Canvas P2 adds generation tools and stage records, and lays out scenes by their source script instead of by group title."
---

# Canvas generation arrives, and scene groups record where they came from

English | [中文](guide.zh.md)

## Change

The media tools can now generate a node's media without the agent driving each call by hand:

- `canvas_generate` plans a run over the nodes it is given, quotes its video calls, video seconds, image calls, spoken lines, and music calls, and starts it only after the user agrees to the quote. One storyboard becomes one video node per segment.
- `storyboard_voice` creates one audio node per spoken line and keeps them matched to their line across storyboard rewrites.
- `studio_stage` records and advances the production stage of the current episode.

Two deployment-facing details changed:

- `tool-media` accepts five new keys: `videoRefModel`, `maxSegmentSeconds`, `generateConcurrency`, and the `confirm*` thresholds that decide when a run needs the user's agreement.
- `studio_expand_script` deduplicates by the scene group's recorded origin (`sceneOrigin: { script, scene }`) instead of its title. A group a user renamed no longer causes a second copy of the scene, and a group that merely happens to be titled `场1` is no longer mistaken for one.

`studio_bible_update` now replaces an entry with the same id, as its description always said, instead of appending a second entry with that id.

## Migration

1. Re-run `studio_expand_script` only if a project needs the new origin records; existing canvases stay readable and the missing field is treated as "not laid out from a script".
2. If a project depends on the old title-based deduplication, clear duplicate scene groups by hand before expanding the script again.
3. Deployments that quote their own models should set `videoRefModel` and `maxSegmentSeconds` to match what their gateway allows.
