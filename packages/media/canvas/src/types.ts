/**
 * Pure types of the canvas document and its edit operations, free of Host imports so the Client
 * can consume them through `./client`.
 * @module @deepseek-ai/dsh-canvas/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'

/** Node kinds a canvas holds. */
export type CanvasNodeType = 'image' | 'video' | 'audio' | 'text' | 'script' | 'storyboard' | 'timeline' | 'group'

/** Node kinds that carry content; a group only frames other nodes. */
export type CanvasContentType = Exclude<CanvasNodeType, 'group'>

/** Document-unique node id: `n<k>` for content nodes, `g<k>` for groups. */
export type CanvasNodeId = Branded<'CanvasNodeId'>

/** One production stage of an episode, in the order they run. */
export type StageId = 'brief' | 'bible' | 'assets' | 'script' | 'storyboard' | 'generating' | 'post' | 'delivered'

/** A check that must pass before a stage advances or a generation runs. */
export type GateId = 'G1_bible_first' | 'G2_storyboard_quality' | 'G3_one_video_per_shots' | 'G4_stage_order' | 'G5_destructive' | 'tail_chain'

/** One stage record of an episode, with the gate overrides a user granted. */
export interface EpisodeProduction {
  readonly stage: StageId
  readonly overrides: readonly { readonly gate: GateId; readonly at: string; readonly reason: string }[]
}

/** `.canvas/production.json`. */
export interface Production {
  readonly version: 1
  /** Incremented by every successful write. */
  readonly revision: number
  readonly episodes: Readonly<Record<string, EpisodeProduction>>
}

/** Where a scene group came from, so laying the same script out again reuses it. */
export interface SceneOrigin {
  /** Script node the scene was parsed from. */
  readonly script: CanvasNodeId
  /** Scene number inside that script. */
  readonly scene: number
}

/** One canvas of a project: `e1`, `e2`, … in creation order. */
export type EpisodeId = Branded<'EpisodeId'>

/** One bible entry: `c<k>` character, `l<k>` location, `p<k>` prop. */
export type BibleEntryId = Branded<'BibleEntryId'>

/** One shot of a storyboard: `s<k>`, unique within its table and stable across reorders. */
export type ShotId = Branded<'ShotId'>

/** One spoken line of a shot: `d<k>`, unique within its table and stable across rewrites. */
export type DialogueId = Branded<'DialogueId'>

/** One version of a node's content: `v<k>`, increasing within the node. */
export type VersionId = Branded<'VersionId'>

/** One clip of a timeline: `k<k>`, unique within the timeline file. */
export type TimelineClipId = Branded<'TimelineClipId'>

/** Why an edge exists. */
export type CanvasEdgeKind = 'derivation' | 'reference'

/** What a reference edge supplies to its target. */
export type CanvasEdgeRole = 'prompt' | 'ref' | 'first_frame' | 'last_frame' | 'audio' | 'source'

/** A file one generated version consumed, with the version it was taken from. */
export interface NodeInput {
  /** Source node the input came from. */
  readonly node: CanvasNodeId
  /** Source version the input file belonged to. */
  readonly version: VersionId
  /** Edge role that carried the input, when the edge declares one. */
  readonly role?: CanvasEdgeRole
  /** Absolute path handed to the model. */
  readonly path: string
}

/** Beat grid detected on an audio version. */
export interface BeatGrid {
  /** Estimated tempo in beats per minute. */
  readonly bpm: number
  /** Beat positions in milliseconds, ascending. */
  readonly beatsMs: readonly number[]
  /** Sections split on energy changes. */
  readonly sections: readonly { readonly fromMs: number; readonly toMs: number }[]
}

/** One stored version of a node's content. */
export interface NodeVersion {
  /** `v<k>`, increasing within the node. */
  readonly id: VersionId
  /** Absolute media file path; present on image, video, and audio versions. */
  readonly path?: string
  /** Text body; present on text and script versions. */
  readonly text?: string
  /** Shots; present on storyboard versions. */
  readonly shots?: readonly Shot[]
  /** Complete prompt sent to the model, with `@` mentions expanded. */
  readonly prompt?: string
  /** Model that produced the version. */
  readonly model?: string
  /** Generation parameters as the gateway accepted them. */
  readonly params?: Readonly<Record<string, string | number | boolean>>
  /** Files this version was generated from, in input order. */
  readonly inputs?: readonly NodeInput[]
  /** Media duration in milliseconds, probed after generation. */
  readonly durationMs?: number
  /** Pixel width of the media. */
  readonly width?: number
  /** Pixel height of the media. */
  readonly height?: number
  /** Beat grid written by the beat detection tool. */
  readonly beats?: BeatGrid
  /** ISO timestamp when the version was created. */
  readonly createdAt: string
  /** Who introduced the version. */
  readonly origin: 'agent' | 'user' | 'import'
}

/** What a node generates. */
export type GenerationKind = 'image' | 'video' | 'speech' | 'music'

/** How a node's content is generated; present on image, video, and audio nodes. */
export interface GenerationSpec {
  /** Kind of media this node generates. */
  readonly kind: GenerationKind
  /** Prompt written by the user or the agent; may mention bible entries as `@name`. */
  readonly prompt: string
  /** Model id; the deployment default applies when absent. */
  readonly model?: string
  /** Parameters as the capability catalog names them. */
  readonly params: Readonly<Record<string, string | number | boolean>>
  /** Which shots of which storyboard this video stands for. */
  readonly shot?: { readonly storyboard: CanvasNodeId; readonly shots: readonly ShotId[] }
  /** Which line of which shot this audio voices. */
  readonly dialogue?: { readonly storyboard: CanvasNodeId; readonly shot: ShotId; readonly line: DialogueId }
  /** `false` opts this segment out of tail-frame chaining; absent means chain when the segment asks for it. */
  readonly tailChain?: boolean
}

/** Progress of the generation task behind a node; absent once the node has no pending work. */
export type NodeStatus =
  | { readonly state: 'queued'; readonly jobId: JobId; readonly at: string }
  | { readonly state: 'running'; readonly jobId: JobId; readonly at: string; readonly progress?: number }
  | { readonly state: 'failed'; readonly at: string; readonly error: string; readonly retryable: boolean }

/** Timeline data of a `timeline` node, stored beside the canvas. */
export interface TimelineRef {
  /** Timeline file path relative to `.canvas/`. */
  readonly file: string
  /** Total duration in milliseconds. */
  readonly durationMs: number
  /** Exports produced from this timeline. */
  readonly exports: readonly ExportRecord[]
}

/** One export of a timeline. */
export interface ExportRecord {
  /** Video node the export landed on. */
  readonly node: CanvasNodeId
  /** Preset id the export used. */
  readonly preset: string
  /** Timeline revision the export was rendered from. */
  readonly timelineRevision: number
  /** ISO timestamp of the export. */
  readonly at: string
}

/** One node of the canvas document. */
export interface CanvasNode {
  /** Node id: `n<k>` for content nodes, `g<k>` for groups. */
  readonly id: CanvasNodeId
  readonly type: CanvasNodeType
  readonly title: string
  /** Top-left corner in canvas units. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Id of the group this node belongs to. */
  readonly group?: CanvasNodeId
  /** Whether a user positioned the node; layout never moves a placed node. */
  readonly placed?: boolean
  /** Stored versions, oldest first; the active version is never evicted by the version limit. */
  readonly versions?: readonly NodeVersion[]
  /** Version whose content the node currently shows. */
  readonly activeVersion?: VersionId
  /** How the node generates its content. */
  readonly gen?: GenerationSpec
  /** Progress of the node's pending generation task. */
  readonly status?: NodeStatus
  /** Bible entry this image belongs to, such as a character turnaround. */
  readonly bible?: BibleEntryId
  /** Timeline data; present on `timeline` nodes. */
  readonly timeline?: TimelineRef
  /** Video version a tail-frame image was taken from. */
  readonly tailOf?: { readonly node: CanvasNodeId; readonly version: VersionId }
  /** The shots this video stands for no longer exist in its storyboard. */
  readonly stale?: boolean
  /** An input edge now points at a newer version than the one this node was generated from. */
  readonly inputChanged?: boolean
  /** Script and scene number a scene group was laid out from. */
  readonly sceneOrigin?: SceneOrigin
}

/** One directed edge; its id is `<source>-><target>` for derivation and `<source>-><target>:<role>` for reference. */
export interface CanvasEdge {
  readonly id: string
  readonly source: CanvasNodeId
  readonly target: CanvasNodeId
  readonly kind: CanvasEdgeKind
  /** What the edge supplies; present on reference edges only. */
  readonly role?: CanvasEdgeRole
  /** Position within the inputs of one role, starting from 0. */
  readonly order?: number
}

/** The persisted canvas of one episode. */
export interface CanvasDocument {
  readonly version: 2
  /** Incremented by every successful edit. */
  readonly revision: number
  /** Next numeric id suffix; never reused after removals. */
  readonly nextId: number
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasEdge[]
}

/** Camera framing of one shot. */
export type ShotSize = 'extreme_wide' | 'wide' | 'full' | 'medium' | 'medium_close' | 'close' | 'extreme_close' | 'insert'

/** One spoken line of a shot. */
export interface DialogueLine {
  /** `d<k>`, unique within the table and stable across rewrites. */
  readonly id: DialogueId
  /** Who speaks the line; narration has no character entry. */
  readonly speaker: { readonly kind: 'character'; readonly entry: BibleEntryId } | { readonly kind: 'narrator' }
  readonly line: string
}

/** Camera move applied to a still image instead of generating video. */
export interface StillMotion {
  readonly type: 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'pan_up' | 'pan_down' | 'static'
  /** Move strength from 0 to 1. */
  readonly strength: number
}

/** One shot of a storyboard table. */
export interface Shot {
  /** `s<k>`, unique within the table and stable across reorders. */
  readonly id: ShotId
  /** Display title, at most 24 characters. */
  readonly title: string
  /** Camera framing; required by gate G2 before a video is generated. */
  readonly shotSize: ShotSize
  /** What the frame shows. */
  readonly visual: string
  /** What the characters do. */
  readonly motion: string
  /** Camera movement. */
  readonly camera: string
  /** Shot length in seconds. */
  readonly durationSec: number
  /** Characters on screen. */
  readonly characters: readonly BibleEntryId[]
  /** Location of the shot. */
  readonly scene?: BibleEntryId
  /** Props on screen. */
  readonly props: readonly BibleEntryId[]
  /** Spoken lines of the shot. */
  readonly dialogue: readonly DialogueLine[]
  /** Sound effects. */
  readonly sfx: string
  /** Negative prompt terms. */
  readonly negative: string
  /** Still-image camera move; when present the shot needs no generated video. */
  readonly still?: StillMotion
  /** Music window this shot aligns to, in milliseconds. */
  readonly beat?: { readonly fromMs: number; readonly toMs: number }
}

/** One generation segment of a storyboard, derived from its shots and the capability catalog. */
export interface StoryboardSegment {
  readonly index: number
  readonly shots: readonly ShotId[]
  readonly durationSec: number
  readonly kind: 'opening' | 'continuation' | 'scene_change' | 'new_character' | 'closeup'
  readonly join: 'strict' | 'loose' | 'cut'
  /** Whether the segment takes the previous segment's tail frame as its first frame. */
  readonly needsTailChain: boolean
}

/** One edit operation. `ref` names a node created in the same operation list. */
export type CanvasOperation =
  | {
    readonly op: 'add'
    readonly ref?: string
    readonly type: CanvasContentType
    readonly title?: string
    readonly text?: string
    readonly path?: string
    readonly gen?: GenerationSpec
    readonly shots?: readonly Shot[]
    readonly bible?: BibleEntryId
    readonly group?: string
  }
  | { readonly op: 'update'; readonly node: string; readonly title?: string; readonly text?: string; readonly path?: string }
  | { readonly op: 'remove'; readonly node: string }
  | { readonly op: 'set_gen'; readonly node: string; readonly gen: Partial<Omit<GenerationSpec, 'params'>> & { readonly params?: Readonly<Record<string, string | number | boolean | null>> } }
  | { readonly op: 'set_text'; readonly node: string; readonly text: string }
  | { readonly op: 'set_shots'; readonly node: string; readonly shots: readonly Shot[] }
  | { readonly op: 'update_shot'; readonly node: string; readonly shot: string; readonly patch: Partial<Omit<Shot, 'id'>> }
  | { readonly op: 'insert_shot'; readonly node: string; readonly after?: string; readonly shot: Omit<Shot, 'id'> }
  | { readonly op: 'remove_shot'; readonly node: string; readonly shot: string }
  | { readonly op: 'move_shot'; readonly node: string; readonly shot: string; readonly after?: string }
  | { readonly op: 'set_version'; readonly node: string; readonly version: string }
  | { readonly op: 'connect'; readonly from: string; readonly to: string; readonly kind?: CanvasEdgeKind; readonly role?: CanvasEdgeRole; readonly order?: number }
  | { readonly op: 'disconnect'; readonly from: string; readonly to: string; readonly role?: CanvasEdgeRole }
  | { readonly op: 'reorder_refs'; readonly node: string; readonly sources: readonly string[] }
  | {
    readonly op: 'group'
    readonly ref?: string
    readonly title?: string
    readonly nodes: readonly string[]
    /** Script and scene this group stands for, when it is a scene group. */
    readonly sceneOrigin?: SceneOrigin
  }
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
  /** Document revision after this call. */
  readonly revision: number
  /** Ids assigned to the `ref` names of this call. */
  readonly refs: Readonly<Record<string, CanvasNodeId>>
  /** Ids of the nodes and groups this call created, in creation order. */
  readonly created: readonly CanvasNodeId[]
  readonly skipped: readonly CanvasSkippedOperation[]
}

/** Revisions of the files one change wrote. */
export interface CanvasRevisions {
  readonly canvas?: number
  readonly project?: number
  readonly bible?: number
  readonly production?: number
}

/** One episode as the Client lists it. */
export interface CanvasEpisode {
  readonly id: EpisodeId
  readonly title: string
}

/** One project's canvas as a Client reads it. */
export interface CanvasView {
  /** Project directory that owns the document. */
  readonly directory: string
  /** Episode the view shows. */
  readonly episode: CanvasEpisode
  /** Revisions of the files the view read. */
  readonly revisions: CanvasRevisions
  readonly document: CanvasDocument
}

/** Notification that one project's canvas files changed. */
export interface CanvasChange {
  /** Project directory that owns the document. */
  readonly directory: string
  /** Episode whose canvas changed; absent when only project-level files changed. */
  readonly episode?: EpisodeId
  /** Revisions of the files this change wrote. */
  readonly revisions: CanvasRevisions
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A project's canvas files were rewritten.
     * @mode emit
     * @param change - the project directory, episode, and file revisions that changed.
     */
    'canvas/change'(change: CanvasChange): void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The canvas file exists but is not a valid document; it was left untouched. */
    'canvas/corrupt': { readonly file: string; readonly reason: string }
    /** The canvas file was written by a newer version of the canvas format; it was left untouched. */
    'canvas/unsupported-version': { readonly file: string; readonly version: number }
    /** The caller's base revision is behind the document; nothing was written. */
    'canvas/conflict': { readonly expected: number; readonly actual: number }
  }
}
