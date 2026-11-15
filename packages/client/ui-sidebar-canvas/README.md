---
description: "See and arrange the project canvas in the Web right sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-canvas

English | [中文](README.zh.md)

## Summary

Adds a Canvas tab to the right sidebar. It shows the project canvas the assistant builds during the conversation: image, video, audio, and text cards, group frames, and the edges between them. The tab follows the assistant's edits as they happen, and the user can move, connect, group, and delete nodes.

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
- id: ui-sidebar-canvas
  name: '@deepseek-ai/dsh-client-ui-sidebar-canvas'
```

The Web bundle ships this row disabled; enable it together with the Host `canvas` row. Open the right sidebar and choose **Canvas** on the start page.

Drag a card to move it, or drag a group frame to move the group with its members. Drag from the handle on a card's right edge to the handle on another card's left edge to connect them. Hold Ctrl or Cmd to select several cards, then use **Group** in the toolbar. Press Delete or use **Delete** to remove the selected cards and edges; deleting a group frame dissolves the group and keeps its members. The toolbar also zooms, fits the view, and refreshes.

Images load when their card appears. Video and audio load when the user presses play. An edit the Host does not fully apply, such as a connection that would form a cycle, is reported in a notice above the canvas while the canvas stays visible.

New-node notices and asset selections locate their nodes. The inspector saves only changed generation fields; an external edit of the same field requires reloading or explicit overwrite. First/last-frame selectors exclude images downstream of the video. Three-view generation creates and runs a real image node. Fullscreen preserves the current view and exits with Escape. Videos that fail browser decoding can prepare a local compatible preview through the Host media service without changing their recorded version.

Create a timeline from the canvas toolbar, or open a timeline node from its inspector or by double-clicking it. The full-screen editor embeds the Session conversation, a full-quality cached video, clip and output parameters, and multi-track editing. Source insertion pins a selected node version. Parameter drafts survive concurrent edits, failed reads, and connection replacement; merging and discarding are explicit. History, undo, and redo use the Host's saved revisions. Preview uses the file resource and native streamed playback of the same MP4 used for export; unavailable or outdated caches cannot be exported.

Create music or speech nodes from the toolbar and open their audio application from the inspector or by double-clicking. The application contains the shared conversation, version listening, and model parameters; selecting a version only changes the preview, and adopting it is explicit. Returned ABC scores remain readable when the model catalog is unavailable. Unsaved drafts survive disconnection and require explicit discard on closing. Model availability and supported audio modes come from the [media service](../../media/tool-media/README.md).

<a id="understand-the-implementation"></a>
## Understand the implementation

`CanvasSource` holds one Session's canvas state. It reads through `canvas.get`, sends edits through `canvas.apply`, reads again after every edit and after a `canvas/change` event for the project it shows, and lets only the latest read publish. A failed refresh keeps the last document on screen. Queued writes retain their project, episode, and connection; an owner change refuses unsent work and ignores late acknowledgements. Known writes enter undo history immediately, while parameter drafts clear only after a successful reread. An unconfirmed transport outcome requires rereading and checking before retrying.

The Host owns the document. Gestures become operation lists (`move`, `connect`, `group`, `ungroup`, `remove`, `disconnect`), and the flow is redrawn from the document the Host returns; positions and ids are never decided in the browser. `flow.ts` holds the pure mapping in both directions.

The flow library, `@xyflow/react`, and the node cards load in a separate chunk the first time a canvas with nodes is shown. Media bytes are read with `workspaceFiles.readBytes` and shown through object URLs that are revoked when a card unmounts.

<a id="model-experience"></a>
## Model Experience

None, as this package shows the canvas and sends the user's edits to the Host without adding model input.

#### KV Cache effect

None; canvas documents and media bytes travel only between the browser and the Host.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No resizing of cards.
- A media file larger than the Host's full-file read limit shows a load failure on its card.
- The overview map is hidden when the tab is narrower than 720px.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
