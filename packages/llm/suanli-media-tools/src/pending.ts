/** Gateway tasks a call submitted and has not settled, kept across Host restarts so a repeated call resumes the task. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { MediaSubmitRequest } from '@deepseek-ai/dsh-suanli-media-tasks/types'
import { z } from 'zod'

/** Oldest task a repeated call still resumes; the gateway drops task results after about a day. */
const PENDING_TTL_MS = 24 * 60 * 60_000

const taskSchema = z.object({
  taskId: z.string(),
  submittedAt: z.number(),
  session: z.string().optional(),
  cwd: z.string().optional(),
  operation: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  userTextHash: z.string().optional(),
  taskType: z.string().optional(),
  requestHash: z.string().optional(),
})

/** One unsettled task. */
type StoredTask = z.infer<typeof taskSchema>

/**
 * Domain of unsettled tasks, keyed by the request fingerprint. `backup-and-skip` drops a record this
 * package can no longer read: losing it only means the next call submits again.
 */
export const pendingTasksDomain = defineDomain({
  // 域名必须匹配存储域的 UNIT_NAME_RE（`^[a-z][a-z0-9_]*$`）。
  name: 'suanli_media_pending',
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { tasks: domainTable(taskSchema) },
})

/** The table operations the store needs. */
interface TaskTable {
  get(key: string): StoredTask | undefined
  entries(): IterableIterator<[string, StoredTask]>
  put(key: string, value: StoredTask): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Session and submission identity kept with a pending task. */
export interface PendingIdentity {
  readonly session: string
  readonly cwd: string
  readonly request: MediaSubmitRequest
  /** Hash of the exact user message that initiated the generation, when the Session is readable. */
  readonly userTextHash?: string
}

/** Unsettled tasks of the media tools. */
export interface PendingTasks {
  /**
   * Find the task an identical or minor-reworded earlier request submitted and never settled.
   * @param key - exact request fingerprint.
   * @param identity - session and submission used only after the exact key misses.
   * @returns the matching record key and gateway task id, or undefined.
   */
  find(key: string, identity?: PendingIdentity): Promise<{ readonly key: string; readonly taskId: string } | undefined>
  /**
   * Remember a submitted task until it settles.
   * @param key - request fingerprint.
   * @param taskId - gateway task id.
   * @param identity - session and submission retained for restart-tolerant matching.
   */
  remember(key: string, taskId: string, identity?: PendingIdentity): Promise<void>
  /**
   * Forget a task that delivered, failed, or was cancelled.
   * @param key - request fingerprint.
   */
  forget(key: string): Promise<void>
}

/** Prompts above this character-bigram similarity are the same request rephrased by the model, not a new task. */
const REWORDED_PROMPT_SIMILARITY = 0.6

function normalizedPrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function promptSimilarity(left: string, right: string): number {
  const a = normalizedPrompt(left)
  const b = normalizedPrompt(right)
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const count = (text: string): Map<string, number> => {
    const grams = new Map<string, number>()
    for (let index = 0; index < text.length - 1; index += 1) {
      const gram = text.slice(index, index + 2)
      grams.set(gram, (grams.get(gram) ?? 0) + 1)
    }
    return grams
  }
  const agrams = count(a)
  const bgrams = count(b)
  let overlap = 0
  for (const [gram, amount] of agrams) overlap += Math.min(amount, bgrams.get(gram) ?? 0)
  return overlap * 2 / (a.length - 1 + b.length - 1)
}

function requestHash(request: MediaSubmitRequest): string {
  const params = Object.entries(request.params ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256')
    .update(JSON.stringify([
      request.operation, request.model, request.taskType ?? null,
      request.referenceImages ?? [], params,
      ...request.sourceVideo !== undefined ? [request.sourceVideo] : [],
    ]))
    .digest('hex')
}

function rewordedMatch(record: StoredTask, identity: PendingIdentity): boolean {
  const request = identity.request
  return record.session === identity.session
    && record.cwd === identity.cwd
    && record.operation === request.operation
    && record.model === request.model
    && (record.taskType ?? null) === (request.taskType ?? null)
    && record.requestHash === requestHash(request)
    && record.userTextHash !== undefined
    && record.userTextHash === identity.userTextHash
    && record.prompt !== undefined
    && promptSimilarity(record.prompt, request.prompt) >= REWORDED_PROMPT_SIMILARITY
}

function storedIdentity(identity: PendingIdentity): Omit<StoredTask, 'taskId' | 'submittedAt'> {
  const request = identity.request
  return {
    session: identity.session,
    cwd: identity.cwd,
    operation: request.operation,
    model: request.model,
    prompt: request.prompt,
    ...identity.userTextHash === undefined ? {} : { userTextHash: identity.userTextHash },
    ...request.taskType === undefined ? {} : { taskType: request.taskType },
    requestHash: requestHash(request),
  }
}

/**
 * Fingerprint one submission: the same session, workspace, model, prompt, inputs, and parameters give the same key.
 * @param session - session id, so another chat never attaches to this chat's task.
 * @param cwd - session workspace.
 * @param request - the submission.
 * @returns the key.
 */
export function fingerprint(session: string, cwd: string, request: MediaSubmitRequest): string {
  const params = Object.entries(request.params ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256')
    .update(JSON.stringify([
      session, cwd, request.operation, request.model, request.prompt, request.taskType ?? null,
      request.referenceImages ?? [], params,
      ...request.sourceVideo !== undefined ? [request.sourceVideo] : [],
    ]))
    .digest('hex')
}

/**
 * Open the unsettled-task store on first use: the storage domain when the Host mounts one, process memory otherwise.
 * @param ctx - plugin context.
 * @returns the store.
 */
export function pendingTasks(ctx: Context): PendingTasks {
  const memory = new Map<string, StoredTask>()
  let opened: Promise<TaskTable | undefined> | undefined
  const open = async (): Promise<TaskTable | undefined> => await (opened ??= (async () => {
    const facility = ctx.get('storageDomain')
    if (facility === undefined) return undefined
    try {
      return (await facility.open(pendingTasksDomain)).table('tasks')
    } catch (error) {
      ctx.logger.warn('suanli media tools: unsettled tasks are unavailable (%s); keeping them in memory', String(error))
      return undefined
    }
  })())
  return {
    async find(key, identity) {
      const table = await open()
      const entries = [...(table === undefined ? memory.entries() : table.entries())]
      const fresh = (record: StoredTask): boolean => Date.now() - record.submittedAt <= PENDING_TTL_MS
      const exact = entries.find(([itemKey]) => itemKey === key)?.[1]
      if (exact !== undefined && fresh(exact)) return { key, taskId: exact.taskId }
      if (identity === undefined) return undefined
      const matches = entries.filter(([, record]) => fresh(record) && rewordedMatch(record, identity))
      const match = matches.length === 1 ? matches[0] : undefined
      return match === undefined ? undefined : { key: match[0], taskId: match[1].taskId }
    },
    async remember(key, taskId, identity) {
      const table = await open()
      const record = { taskId, submittedAt: Date.now(), ...identity === undefined ? {} : storedIdentity(identity) }
      if (table === undefined) memory.set(key, record)
      else await table.put(key, record)
    },
    async forget(key) {
      const table = await open()
      if (table === undefined) memory.delete(key)
      else await table.delete(key)
    },
  }
}
