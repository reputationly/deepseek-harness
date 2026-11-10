/**
 * Pure types of the canvas document and its edit operations, free of Host imports so the Client
 * can consume them through `./client`.
 * @module @deepseek-ai/dsh-canvas/types
 */

/** Node kinds a canvas holds. */
export type CanvasNodeType = 'image' | 'video' | 'audio' | 'text' | 'group'

/** Node kinds that carry content; a group only frames other nodes. */
export type CanvasContentType = Exclude<CanvasNodeType, 'group'>

/** One node of the canvas document. */
export interface CanvasNode {
  /** Document-unique id: `n<k>` for content nodes, `g<k>` for groups. */
  readonly id: string
  readonly type: CanvasNodeType
  readonly title: string
  /** Top-left corner in canvas units. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Absolute media file path; present on image, video, and audio nodes. */
  readonly path?: string
  /** Text content; present on text nodes. */
  readonly text?: string
  /** Prompt that generated the media file. */
  readonly prompt?: string
  /** Model that generated the media file. */
  readonly model?: string
  /** Id of the group this node belongs to. */
  readonly group?: string
  /** Whether a user positioned the node; layout never moves a placed node. */
  readonly placed?: boolean
}

/** Why an edge exists. */
export type CanvasEdgeKind = 'derivation' | 'reference'

/** One directed edge; its id is `<source>-><target>`. */
export interface CanvasEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly kind: CanvasEdgeKind
}

/** The persisted canvas of one project directory. */
export interface CanvasDocument {
  readonly version: 1
  /** Next numeric id suffix; never reused after removals. */
  readonly nextId: number
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasEdge[]
}

/** One edit operation. `ref` names a node created in the same operation list. */
export type CanvasOperation =
  | { readonly op: 'add'; readonly ref?: string; readonly type: CanvasContentType; readonly title?: string; readonly path?: string; readonly text?: string; readonly prompt?: string; readonly model?: string; readonly group?: string }
  | { readonly op: 'update'; readonly node: string; readonly title?: string; readonly text?: string; readonly path?: string }
  | { readonly op: 'remove'; readonly node: string }
  | { readonly op: 'connect'; readonly from: string; readonly to: string; readonly kind?: CanvasEdgeKind }
  | { readonly op: 'disconnect'; readonly from: string; readonly to: string }
  | { readonly op: 'group'; readonly ref?: string; readonly title?: string; readonly nodes: readonly string[] }
  | { readonly op: 'ungroup'; readonly node: string }
  | { readonly op: 'move'; readonly node: string; readonly x: number; readonly y: number }
  | { readonly op: 'resize'; readonly node: string; readonly width: number; readonly height: number }

/** One operation that was not applied, with its position in the list and the reason. */
export interface CanvasSkippedOperation {
  readonly index: number
  readonly op: CanvasOperation['op']
  readonly reason: string
}

/** Outcome of one operation list. */
export interface CanvasEditResult {
  /** Ids assigned to the `ref` names of this call. */
  readonly refs: Readonly<Record<string, string>>
  /** Ids of the nodes and groups this call created, in creation order. */
  readonly created: readonly string[]
  readonly skipped: readonly CanvasSkippedOperation[]
}

/** One project's canvas as a Client reads it. */
export interface CanvasView {
  /** Project directory that owns the document. */
  readonly directory: string
  readonly document: CanvasDocument
}

/** Notification that one project's canvas document changed. */
export interface CanvasChange {
  /** Project directory that owns the document. */
  readonly directory: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A project's canvas document was rewritten.
     * @mode emit
     * @param change - the project directory whose canvas changed.
     */
    'canvas/change'(change: CanvasChange): void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The canvas file exists but is not a valid document; it was left untouched. */
    'canvas/corrupt': { readonly file: string; readonly reason: string }
  }
}
