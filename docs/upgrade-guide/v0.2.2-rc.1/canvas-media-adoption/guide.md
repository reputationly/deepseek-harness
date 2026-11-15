---
kind: upgrade-guide
description: Canvas format 3 separates generated media candidates from adopted versions.
---

# Explicit media adoption on the canvas

English | [中文](guide.zh.md)

## Change

Canvas format 3 stores generated images, video, music, and speech as unadopted candidates. Generation preserves adoption; downstream generation reads adopted inputs. Previewing never adopts.

Formats 1 and 2 remain readable. Their previously displayed versions become explicit selections during migration. Older builds cannot read format 3. Script, bible, and storyboard document structures are unchanged.

Custom Clients must pass the captured project directory and episode to `media.videoPreview(session, node, version, scope)` to prevent cross-project reads. **Retry preview** rereads the selected candidate without generation or adoption.

Use `media.editMedia(session, request)` or `media_edit` with exact source node/version and captured project scope. Local `media-edit` jobs produce candidates without paid-generation checkpoints. Failures expose `media/edit` details: `kind` and any completed file's `path`. Reread unknown outcomes before retrying; identical requests reuse candidates or completed output. Canvas Host `edit(..., { atomic: true })` rejects batches containing skipped operations; `add.initialVersion` attaches completed candidate metadata atomically.

Staged `media.importVideo`/`media.importAudio` accept `LocalMediaImportRequest` receipts owned by the receiving Session. Verified bytes stream into the captured project's `.canvas/imports/` as unadopted versions without complete-file RPC or cloud generation. **New video** starts video uploads; music and speech offer **Upload local audio** before generation.

Canvas uploads, direct edits, preview renders, and direct generation set `JobSpec.completionNotice` to `'none'` to update UI without starting Agent turns. Model-started jobs retain completion delivery. Upgrade `jobs`, `jobs-local`, `tool-jobs`, and media services together.

Custom Clients publish hints through `canvas.editorContext(session, context)`; omitting context clears them. Captured project scope, application, node/version, timeline selection, and the unsaved-draft flag enter logged runtime context before model requests; draft values are excluded. Hints neither save nor adopt. Upgrade canvas with its Agent/system-prompt dependencies. Clients omitting this call still work without selection hints.

## Migration

1. Back up the project's `.canvas/` directory before upgrading. Upgrade the Host and reload the Web client or restart Desktop together.
2. Open the project. The first successful canvas edit writes format 3; opening a file alone does not rewrite it. Check that the previously selected media still appears as adopted.
3. Adopt a candidate before using that node as a generation reference. Use the editor's adoption action or `canvas_edit` with `set_version`. Refresh legacy video tails that lack an exact source-version record before continuing a segment. Timeline sources pin opaque version IDs, including imports and local edits.
4. Update integrations that construct `CanvasDocument` to emit version 3, or read existing JSON through `parseCanvas`. A missing `activeVersion` means no adopted version; integrations must not fall back to the newest stored version when resolving inputs.
5. To return to an older build, restore the backup. Do not change the version number on a format-3 file.
