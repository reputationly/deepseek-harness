/** Injected canvas state, edits, and media reads. */
import type { HostObservable, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { MediaCapabilityView } from '@deepseek-ai/dsh-api-remotes/client'
import type { Bible, CanvasEditorContext, CanvasNodeId, CanvasScope, VersionId } from '@deepseek-ai/dsh-canvas/client'
import type { MediaPlanView } from '@deepseek-ai/dsh-api-remotes/client'
import type { CanvasSource, CanvasState } from './canvas-source.ts'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { TimelineActions, TimelineState } from './timeline-source.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { LocalMediaEditRequest, LocalMediaEditResult } from '@deepseek-ai/dsh-api-remotes/client'

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

/**
 * Preview an exact video version through the project-bound callback supplied to its card.
 * @param node - recorded video node.
 * @param version - exact history version, whether adopted or a candidate.
 * @param signal - cancels the caller's media read.
 * @returns compatible bytes or the Host's failure, without adopting the version.
 */
export type PreviewCanvasVideo = (node: CanvasNodeId, version: VersionId, signal: AbortSignal) => Promise<CanvasFile>

/** Project-bound compatible video preparation and the authorized streaming file resource seat. */
export type CanvasVideoFiles = Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useResource' | 'sessionId'> & {
  readonly scope: CanvasScope
  readonly videoPath: NonNullable<CanvasInjected['videoPath']>
}

/** The canvas tab's injected face. */
export interface CanvasInjected {
  /**
   * Share selection hints through the logged model-context provider; never save draft values.
   * @param context - editor selection, or undefined when the canvas closes.
   * @returns the Host acknowledgement or a typed failure.
   */
  readonly editorContext?: (context: CanvasEditorContext | undefined) => Promise<RemoteResult<void>>
  /** Stream a file through the existing upload service, then import into the captured video node. */
  readonly importVideo?: (
    node: CanvasNodeId,
    scope: CanvasScope,
    file: File,
    signal: AbortSignal,
  ) => Promise<RemoteResult<LocalMediaEditResult> | undefined>
  /** Import local music or speech through the same Session-owned staged upload service. */
  readonly importAudio?: (
    node: CanvasNodeId,
    scope: CanvasScope,
    file: File,
    signal: AbortSignal,
  ) => Promise<RemoteResult<LocalMediaEditResult> | undefined>
  /** Prepare a compatible absolute video path for streaming through the file resource seat. */
  readonly videoPath?: (
    node: CanvasNodeId,
    version: VersionId,
    scope: CanvasScope,
  ) => Promise<RemoteResult<string> | undefined>
  /** A missing reply means the optional media provider is unavailable; other failures retain their typed Remote details. */
  readonly editMedia?: (request: LocalMediaEditRequest) => Promise<RemoteResult<LocalMediaEditResult> | undefined>
  /** The rendering canvas supplies its captured project and episode, including for relative media paths. */
  readonly previewVideo?: (
    node: CanvasNodeId,
    version: VersionId,
    scope: CanvasScope,
    signal: AbortSignal,
  ) => Promise<CanvasFile>
  readonly hooks: {
    readonly canvas: HostObservable<CanvasState>
    readonly localeState: HostObservable<LocaleSnapshot>
    readonly timeline: HostObservable<TimelineState>
  }
  readonly timeline: TimelineActions
  readonly load: CanvasSource['load']
  readonly edit: CanvasSource['edit']
  readonly dismiss: CanvasSource['dismiss']
  readonly readFile: ReadCanvasFile
  /** Models and parameters the deployment's gateway catalog offers for one operation. */
  readonly capabilities: (operation: string) => Promise<readonly MediaCapabilityView[]>
  /** Reads the shared bible the panels show. */
  readonly bible: () => Promise<{ readonly bible: Bible; readonly revision: number }>
  /** Plans generation for the given nodes, or undefined when the deployment has no media namespace. */
  readonly planNodes?: (nodes: readonly string[], scope?: CanvasScope) => Promise<MediaPlanView | undefined>
  /** Starts generation for the given nodes. */
  readonly generateNodes?: (
    nodes: readonly string[],
    scope?: CanvasScope,
  ) => Promise<MediaPlanView | undefined>
}
