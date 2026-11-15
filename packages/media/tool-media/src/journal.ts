/** Durable checkpoints for canvas media attempts. Credentials and request headers never enter this file. */
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { parseCanvas, type CanvasNodeId, type NodeVersion, type VersionId } from '@deepseek-ai/dsh-canvas'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { GeneratedMedia } from './runner.ts'

/** An existing remote task can be polled again without submitting another billable request. */
export interface RemoteMediaTask {
  readonly id: string
  readonly model: string
  readonly kind: 'video' | 'music' | 'speech'
  /** SHA-256 of the gateway root; no endpoint credentials are persisted. */
  readonly endpoint: string
}

/** Stable identity of a local media attempt, including its crash-recovery checkpoints. */
export type MediaAttemptId = Branded<'MediaAttemptId'>

/** One generation attempt and the version it must eventually attach. */
export interface MediaCheckpoint {
  readonly version: 1
  readonly id: MediaAttemptId
  readonly node: CanvasNodeId
  readonly baseVersion?: VersionId
  readonly jobId?: JobId
  readonly state: 'queued' | 'running' | 'produced' | 'failed' | 'cancelled'
  /** False until the durable intent is recorded immediately before the paid request. */
  readonly submissionStarted?: boolean
  readonly versionBody: Omit<NodeVersion, 'id'>
  readonly remote?: RemoteMediaTask
  readonly media?: GeneratedMedia
  readonly error?: string
  readonly retryable?: boolean
  readonly recoveryRequired?: boolean
}

/** Persistence needed by the runner; one file per attempt avoids a shared mutable task index. */
export interface MediaJournal {
  readonly scope: string
  read(): Promise<readonly MediaCheckpoint[]>
  write(checkpoint: MediaCheckpoint): Promise<void>
  remove(id: MediaAttemptId): Promise<void>
  /** Serialize checkpoint inspection and job admission across owners of the same physical journal. */
  withRecoveryLock?<T>(operation: () => Promise<T>): Promise<T>
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('media checkpoint must be an object')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('media checkpoint needs a nonempty string')
  return value
}

function attemptId(value: unknown): MediaAttemptId {
  const id = text(value)
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('invalid media attempt id')
  return brandString<MediaAttemptId>(id)
}

/** Validate a checkpoint from disk using the canvas parser for its nested version payload. */
function parseCheckpoint(source: string): MediaCheckpoint {
  const raw = object(JSON.parse(source))
  if (raw.version !== 1) throw new Error('unsupported media checkpoint version')
  const state = raw.state
  if (state !== 'queued' && state !== 'running' && state !== 'produced' && state !== 'failed' && state !== 'cancelled') {
    throw new Error('invalid media checkpoint state')
  }
  const body = object(raw.versionBody)
  const validated = parseCanvas(JSON.stringify({
    version: 2, revision: 0, nextId: 2, edges: [],
    nodes: [{ id: 'n1', type: 'image', title: '', x: 0, y: 0, width: 1, height: 1,
      versions: [{ ...body, id: 'v1' }], activeVersion: 'v1' }],
  })).nodes[0]?.versions?.[0]
  if (validated === undefined) throw new Error('media checkpoint has no version body')
  const { id: _versionId, ...versionBody } = validated
  let remote: RemoteMediaTask | undefined
  if (raw.remote !== undefined) {
    const value = object(raw.remote)
    if (value.kind !== 'video' && value.kind !== 'music' && value.kind !== 'speech') throw new Error('invalid remote media kind')
    const endpoint = text(value.endpoint)
    if (!/^[a-f0-9]{64}$/u.test(endpoint)) throw new Error('invalid media endpoint fingerprint')
    remote = { id: text(value.id), model: text(value.model), kind: value.kind, endpoint }
  }
  let media: GeneratedMedia | undefined
  if (raw.media !== undefined) {
    const value = object(raw.media)
    const dimensions: { durationMs?: number; width?: number; height?: number } = {}
    for (const key of ['durationMs', 'width', 'height'] as const) {
      if (value[key] === undefined) continue
      if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) throw new Error(`invalid media ${key}`)
      dimensions[key] = value[key]
    }
    let params: Record<string, string | number | boolean> | undefined
    if (value.params !== undefined) {
      params = {}
      for (const [key, parameter] of Object.entries(object(value.params))) {
        if (typeof parameter !== 'string' && typeof parameter !== 'boolean' && (typeof parameter !== 'number' || !Number.isFinite(parameter))) {
          throw new Error(`invalid media parameter ${key}`)
        }
        params[key] = parameter
      }
    }
    media = { path: text(value.path), model: text(value.model), ...dimensions, ...params === undefined ? {} : { params } }
  }
  if (raw.retryable !== undefined && typeof raw.retryable !== 'boolean') throw new Error('invalid media retryability')
  if (raw.recoveryRequired !== undefined && typeof raw.recoveryRequired !== 'boolean') throw new Error('invalid media recovery flag')
  if (raw.submissionStarted !== undefined && typeof raw.submissionStarted !== 'boolean') throw new Error('invalid media submission flag')
  return {
    version: 1, id: attemptId(raw.id), node: brandString<CanvasNodeId>(text(raw.node)), state, versionBody,
    ...raw.baseVersion === undefined ? {} : { baseVersion: brandString<VersionId>(text(raw.baseVersion)) },
    ...raw.jobId === undefined ? {} : { jobId: brandString<JobId>(text(raw.jobId)) },
    ...remote === undefined ? {} : { remote },
    ...media === undefined ? {} : { media },
    ...raw.error === undefined ? {} : { error: text(raw.error) },
    ...raw.retryable === undefined ? {} : { retryable: raw.retryable },
    ...raw.recoveryRequired === undefined ? {} : { recoveryRequired: raw.recoveryRequired },
    ...raw.submissionStarted === undefined ? {} : { submissionStarted: raw.submissionStarted },
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Atomic, validated checkpoints under a single episode's private media directory. */
export class FileMediaJournal implements MediaJournal {
  /** @param scope - absolute directory dedicated to this episode's attempts. */
  constructor(readonly scope: string) {}

  /** Serialize recovery admission across owners of this journal.
   * @param operation - short recovery admission; remote polling runs after this lock is released.
   * @returns the operation result after releasing its filesystem lock.
   */
  async withRecoveryLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.scope, { recursive: true })
    return withFileLock(join(this.scope, 'recovery'), operation)
  }

  /** @returns validated pending attempts; malformed files remain intact and stop recovery visibly. */
  async read(): Promise<readonly MediaCheckpoint[]> {
    let files: string[]
    try {
      files = await readdir(this.scope)
    } catch (error: unknown) {
      if (missing(error)) return []
      throw error
    }
    return Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async (file) => {
      try {
        const checkpoint = parseCheckpoint(await readFile(join(this.scope, file), 'utf8'))
        if (file !== `${checkpoint.id}.json`) throw new Error('media checkpoint id does not match its filename')
        return checkpoint
      } catch (error: unknown) {
        throw new Error(`Cannot recover media checkpoint ${join(this.scope, file)}: ${String(error)}`, { cause: error })
      }
    }))
  }

  /** @param checkpoint - current attempt, written before moving to its next external side effect. */
  async write(checkpoint: MediaCheckpoint): Promise<void> {
    const source = `${JSON.stringify(checkpoint, null, 2)}\n`
    parseCheckpoint(source)
    const target = join(this.scope, `${attemptId(checkpoint.id)}.json`)
    await writeFileAtomic(target, source, { mode: 0o666 })
  }

  /** @param id - completed attempt whose version was durably attached or explicitly discarded. */
  async remove(id: MediaAttemptId): Promise<void> {
    await rm(join(this.scope, `${attemptId(id)}.json`), { force: true })
  }
}
