/** Injected canvas state, edits, and media reads. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { CanvasSource, CanvasState } from './canvas-source.ts'

/** Bytes of one media file, or why the Host could not serve them. */
export type CanvasFile =
  | { readonly ok: true; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly message: string }

/**
 * Read one media file of the Session's project.
 * @param path - absolute path recorded on the node.
 * @param signal - cancels the read.
 * @returns the bytes or the Host's failure.
 */
export type ReadCanvasFile = (path: string, signal: AbortSignal) => Promise<CanvasFile>

/** The canvas tab's injected face. */
export interface CanvasInjected {
  readonly hooks: { readonly canvas: HostObservable<CanvasState> }
  readonly load: CanvasSource['load']
  readonly edit: CanvasSource['edit']
  readonly dismiss: CanvasSource['dismiss']
  readonly readFile: ReadCanvasFile
}
