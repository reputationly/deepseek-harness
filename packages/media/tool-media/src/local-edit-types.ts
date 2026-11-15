/** Project-bound local media commands, shared by the editing applications and Agent tools. */
import type { CanvasNodeId, CanvasScope, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { FileUploadReceiptId } from '@deepseek-ai/dsh-client-file-upload/types'

/** Import a staged file into an existing audio or video node in the captured project. */
export interface LocalMediaImportRequest {
  readonly scope: CanvasScope
  readonly node: CanvasNodeId
  readonly receipt: FileUploadReceiptId
}

/** Video uploads use the shared media-import request shape. */
export type LocalVideoImportRequest = LocalMediaImportRequest

interface Source {
  readonly scope: CanvasScope
  readonly node: CanvasNodeId
  readonly version: VersionId
}

/**
 * Editing uses an exact history version, including an unadopted candidate. Times are milliseconds.
 * Audio defaults are inMs 0, outMs the measured source end, volume 1, and no fades.
 * Frame and extraction commands require a title for their new candidate node.
 */
export type LocalMediaEditRequest = Source & (
  | { readonly operation: 'audio_edit'; readonly inMs?: number; readonly outMs?: number; readonly volume?: number; readonly fadeInMs?: number; readonly fadeOutMs?: number }
  | { readonly operation: 'extract_audio' | 'first_frame' | 'last_frame' | 'refresh_tail'; readonly title: string }
)

/** A saved candidate; adoption is always a separate canvas operation. */
export interface LocalMediaEditResult {
  readonly node: CanvasNodeId
  readonly version: VersionId
  readonly path: string
  readonly reused: boolean
}

/** Which correction or recovery action a local edit needs. */
export type LocalMediaEditFailure = 'input' | 'source_changed' | 'processing' | 'attachment'
