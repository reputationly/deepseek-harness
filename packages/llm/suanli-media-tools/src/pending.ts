/** Gateway tasks a call submitted and has not settled, kept across Host restarts so a repeated call resumes the task. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { MediaSubmitRequest } from '@deepseek-ai/dsh-suanli-media-tasks/types'
import { z } from 'zod'

/** Oldest task a repeated call still resumes; the gateway drops task results after about a day. */
const PENDING_TTL_MS = 24 * 60 * 60_000

const taskSchema = z.object({ taskId: z.string(), submittedAt: z.number() })

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
  put(key: string, value: StoredTask): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Unsettled tasks of the media tools. */
export interface PendingTasks {
  /**
   * Find the task an identical earlier request submitted and never settled.
   * @param key - request fingerprint.
   * @returns the gateway task id, or undefined.
   */
  find(key: string): Promise<string | undefined>
  /**
   * Remember a submitted task until it settles.
   * @param key - request fingerprint.
   * @param taskId - gateway task id.
   */
  remember(key: string, taskId: string): Promise<void>
  /**
   * Forget a task that delivered, failed, or was cancelled.
   * @param key - request fingerprint.
   */
  forget(key: string): Promise<void>
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
    async find(key) {
      const table = await open()
      const record = table === undefined ? memory.get(key) : table.get(key)
      if (record === undefined || Date.now() - record.submittedAt > PENDING_TTL_MS) return undefined
      return record.taskId
    },
    async remember(key, taskId) {
      const table = await open()
      const record = { taskId, submittedAt: Date.now() }
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
