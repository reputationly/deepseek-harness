---
description: "Package map for the project canvas and the media generation tools."
kind: "package-group"
---

# media/ — Canvas and media generation

English | [中文](README.zh.md)

## Summary

Generate images, video, speech, and music through a media gateway, and keep the project canvas those results land on. The model arranges the canvas in conversation and passes its nodes or groups to the generation tools as inputs.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package owns its configuration and model tools; the subsystem reference describes the canvas document they share.

| Package | Role | ctx key |
|---|---|---|
| [canvas](canvas/README.md) | Project canvas document, the `canvas_get` and `canvas_edit` tools, and the `canvas` Remote namespace | `ctx.canvas` |
| [tool-media](tool-media/README.md) | `generate_image`, `generate_video`, `generate_speech`, and `generate_music` over an OpenAI-compatible media gateway | - |

-----

<a id="related-documentation"></a>
## Related documentation

The Web Client only displays the canvas and forwards user edits.

- [Canvas](../../docs/subsystems/canvas.md) — document, operations, generation inputs, and generated service reference.
- [Canvas tab](../client/ui-sidebar-canvas/README.md) — the right Sidebar tab that shows the canvas.
- [Conversation-driven canvas](../../.agents/notes/implemented/feature/2026-11-10-conversation-driven-canvas.md) — design decisions and alternatives.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
