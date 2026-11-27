/** Steps every generation tool shares: the parameter card, the workspace, and saving artifacts. */

import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CapabilityEntry } from '@deepseek-ai/dsh-suanli-model-catalog/types'
import type { MediaDownloadResult, MediaFailureReason } from '@deepseek-ai/dsh-suanli-media-tasks/types'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-suanli-media-tasks'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-working-directory'
import { check, specOf, type ParameterKind } from './params.ts'
import { questionOf, readAnswer, type OpenParameter } from './questions.ts'

/** Model-readable wording of each task failure. */
const FAILURES: Readonly<Record<MediaFailureReason, string>> = {
  'no-credential': 'the user is not signed in to the gateway',
  unauthorized: 'the gateway key may not use this model',
  'not-found': 'the gateway does not know this model',
  rejected: 'the gateway rejected the request',
  unreachable: 'the gateway could not be reached',
  'timed-out': 'the result did not finish in time',
  cancelled: 'the generation was cancelled',
  'no-artifact': 'the gateway returned no file',
}

/**
 * Error the model and the card read.
 * @param what - which generation, such as `Image`.
 * @param reason - task service reason.
 * @param detail - gateway wording.
 * @returns the error.
 */
export function failure(what: string, reason: MediaFailureReason, detail: string | undefined): Error {
  return new Error(`${what} generation failed: ${FAILURES[reason]}${detail !== undefined && detail !== '' ? ` (${detail})` : ''}.`)
}

/**
 * Settle every closed-set parameter, asking the user once for what is missing or unsupported.
 * @param ctx - plugin context.
 * @param entry - catalog entry of the chosen model.
 * @param requested - each parameter with the value the call carries.
 * @param exec - the execution.
 * @returns parameters by catalog key, or `undefined` when the user cancelled.
 * @throws When the user answered twice with values the model does not accept.
 */
export async function resolveParameters(
  ctx: Context, entry: CapabilityEntry, requested: readonly (readonly [ParameterKind, string | undefined])[], exec: ToolExecution,
): Promise<Record<string, string> | undefined> {
  const settled: Record<string, string> = {}
  let open: OpenParameter[] = []
  for (const [kind, value] of requested) {
    const spec = specOf(entry, kind)
    if (spec === undefined) continue
    const result = check(spec, kind, value)
    if (result.kind === 'ok') settled[spec.key] = result.value
    else open.push({ spec, kind, check: result })
  }
  open = open.sort((left, right) => Number(right.check.kind === 'unsupported') - Number(left.check.kind === 'unsupported'))
  for (let round = 0; open.length > 0; round++) {
    const answer = await ask(ctx, open, exec.agent, exec.signal)
    if (answer === undefined) return undefined
    const again: OpenParameter[] = []
    for (const item of open) {
      const result = readAnswer(item, answer.find(entry => entry.id === item.spec.key))
      if (result === 'skipped') return undefined
      if (result.kind === 'ok') settled[item.spec.key] = result.value
      else again.push({ ...item, check: result })
    }
    if (again.length > 0 && round > 0) {
      throw new Error(`The answers are still not supported: ${again.map(item => item.spec.label).join(', ')}.`)
    }
    open = again
  }
  return settled
}

/**
 * Raise the question card.
 * @param ctx - plugin context.
 * @param open - parameters to ask about.
 * @param agent - the calling agent.
 * @param signal - call cancellation.
 * @returns the answers, or `undefined` when the user skipped or closed the card.
 * @throws When the question service fails for another reason, including call cancellation.
 */
async function ask(ctx: Context, open: readonly OpenParameter[], agent: Agent | undefined, signal: AbortSignal) {
  try {
    const result = await ctx.userQuestions.ask({
      questions: open.map(questionOf),
      ...agent !== undefined ? { agent } : {},
      signal,
    })
    return result.answers.length === 0 ? undefined : result.answers
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === 'ASK_CANCELLED') return undefined
    throw error
  }
}

/**
 * Session workspace of the call.
 * @param ctx - plugin context.
 * @param exec - the execution.
 * @returns the absolute directory; a call outside a session uses the process directory.
 */
export async function workspaceOf(ctx: Context, exec: ToolExecution): Promise<string> {
  if (exec.agent === undefined) return process.cwd()
  return await ctx.workingDirectory.ensure(exec.agent, exec.signal)
}

/**
 * Create the session's `generated/` directory and confirm it stays inside the workspace.
 * @param cwd - session workspace.
 * @returns the directory path.
 * @throws When `generated/` resolves outside the workspace.
 */
export async function outputDirectory(cwd: string): Promise<string> {
  const directory = join(cwd, 'generated')
  await mkdir(directory, { recursive: true })
  if (!await inside(cwd, directory)) throw new Error('The workspace generated/ directory points outside the workspace.')
  return directory
}

/**
 * Whether a path resolves strictly inside the workspace.
 * @param cwd - session workspace.
 * @param path - existing path.
 * @returns the answer.
 */
async function inside(cwd: string, path: string): Promise<boolean> {
  const rel = relative(await realpath(cwd), await realpath(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** One artifact saved under `generated/`. */
export interface SavedArtifact {
  readonly path: string
  readonly data: Uint8Array
}

/**
 * Download an artifact into a private staging directory, then publish it under `generated/`.
 * The final file is created exclusively and receives bytes only once it is proven inside the workspace,
 * so a `generated/` replaced while the gateway was rendering never receives them.
 * @param ctx - plugin context.
 * @param what - which generation, for errors.
 * @param url - artifact URL.
 * @param cwd - session workspace.
 * @param extensionOf - file extension for the downloaded bytes.
 * @returns the saved file and its bytes.
 * @throws When the artifact could not be fetched or published inside the workspace.
 */
export async function saveArtifact(
  ctx: Context, what: string, url: string, cwd: string, extensionOf: (data: Uint8Array) => string,
): Promise<SavedArtifact> {
  return await publishArtifact(ctx, what, cwd, async target => await ctx.suanliMedia.saveArtifact(url, target), extensionOf)
}

/**
 * Let the gateway write into a private staging file, then publish it under `generated/` the way {@link saveArtifact} does.
 * @param _ctx - plugin context.
 * @param what - which generation, for errors.
 * @param cwd - session workspace.
 * @param fill - writes the artifact to the staging path it receives.
 * @param extensionOf - file extension for the written bytes.
 * @returns the saved file and its bytes.
 * @throws When nothing was written or the file could not be published inside the workspace.
 */
export async function publishArtifact(
  _ctx: Context, what: string, cwd: string,
  fill: (target: string) => Promise<MediaDownloadResult>, extensionOf: (data: Uint8Array) => string,
): Promise<SavedArtifact> {
  const staging = await mkdtemp(join(tmpdir(), 'suanli-media-'))
  try {
    const saved = await fill(join(staging, 'artifact'))
    if (!saved.ok) throw failure(what, saved.reason, saved.detail)
    const data = new Uint8Array(await readFile(saved.path))
    await outputDirectory(cwd)
    const directory = join(await realpath(cwd), 'generated')
    const path = join(directory, `${stamp()}-${Math.random().toString(36).slice(2, 8)}${extensionOf(data)}`)
    await writeInside(directory, path, data)
    return { path, data }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/**
 * Create the file exclusively and write the bytes only after proving the new file is the one at
 * `path` under a real `generated/` directory, so a directory swapped for a link never receives them.
 * @param directory - `generated/` under the real workspace path.
 * @param path - the new file.
 * @param data - bytes to write.
 * @throws When the created file is not the one inside the workspace; nothing is written then.
 */
async function writeInside(directory: string, path: string, data: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644)
  try {
    const created = await handle.stat()
    const parent = await lstat(directory)
    const entry = await lstat(path).catch(() => undefined)
    const same = parent.isDirectory() && entry !== undefined && entry.isFile()
      && entry.dev === created.dev && entry.ino === created.ino && created.nlink === 1
    if (!same || !await opensAt(handle.fd, path)) throw new Error('The workspace generated/ directory points outside the workspace.')
    await handle.writeFile(data)
  } finally {
    await handle.close()
  }
}

/**
 * Where the kernel says an open file lives, which no later swap of a parent can fake.
 * @param fd - the open file.
 * @param path - where it must be.
 * @returns false when the file is elsewhere; true where the platform cannot tell (no `/proc`).
 */
async function opensAt(fd: number, path: string): Promise<boolean> {
  if (process.platform !== 'linux') return true
  const actual = await readlink(`/proc/self/fd/${String(fd)}`).catch(() => undefined)
  return actual === undefined || actual === path
}

/**
 * Sortable local time for a file name.
 * @returns `YYYYMMDD-HHMMSS`.
 */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}
