import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WechatRecentSession } from './types.ts'

export interface WechatCredentials {
  readonly token: string
  readonly baseUrl: string
  readonly botId: string
  readonly ownerUserId: string
}

export interface WechatState {
  readonly defaultProjectPath?: string
  readonly currentSessionId?: SessionId
  readonly recentSessions: readonly WechatRecentSession[]
  readonly processedMessageIds: readonly string[]
}

const EMPTY_STATE: WechatState = { recentSessions: [], processedMessageIds: [] }

/** Private, atomic persistence for one local WeChat account. */
export class WechatStore {
  readonly directory: string
  readonly credentialsPath: string
  readonly cursorPath: string
  readonly statePath: string

  constructor(home = process.env.DSH_HOME || join(homedir(), '.dsh')) {
    this.directory = join(home, 'wechat')
    this.credentialsPath = join(this.directory, 'credentials.json')
    this.cursorPath = join(this.directory, 'cursor.json')
    this.statePath = join(this.directory, 'state.json')
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
  }

  async readCredentials(): Promise<WechatCredentials | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.credentialsPath, 'utf8'))
      if (!isRecord(value) || !isNonEmpty(value.token) || !isNonEmpty(value.baseUrl)
        || !isNonEmpty(value.botId) || !isNonEmpty(value.ownerUserId)) {
        throw new Error('saved WeChat credentials are invalid')
      }
      await chmod(this.credentialsPath, 0o600)
      return {
        token: value.token,
        baseUrl: value.baseUrl,
        botId: value.botId,
        ownerUserId: value.ownerUserId,
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw new Error('saved WeChat credentials could not be read')
    }
  }

  async writeCredentials(value: WechatCredentials): Promise<void> {
    await this.writeJson(this.credentialsPath, value)
  }

  async readCursor(): Promise<string> {
    try {
      const value: unknown = JSON.parse(await readFile(this.cursorPath, 'utf8'))
      if (!isRecord(value) || typeof value.get_updates_buf !== 'string') return ''
      await chmod(this.cursorPath, 0o600)
      return value.get_updates_buf
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return ''
      throw new Error('saved WeChat cursor could not be read')
    }
  }

  async writeCursor(cursor: string): Promise<void> {
    await this.writeJson(this.cursorPath, { get_updates_buf: cursor })
  }

  async readState(): Promise<WechatState> {
    try {
      const value: unknown = JSON.parse(await readFile(this.statePath, 'utf8'))
      if (!isRecord(value)) throw new Error('state is not an object')
      await chmod(this.statePath, 0o600)
      return {
        ...(typeof value.defaultProjectPath === 'string' ? { defaultProjectPath: value.defaultProjectPath } : {}),
        ...(typeof value.currentSessionId === 'string' ? { currentSessionId: value.currentSessionId as SessionId } : {}),
        recentSessions: Array.isArray(value.recentSessions) ? value.recentSessions as WechatRecentSession[] : [],
        processedMessageIds: Array.isArray(value.processedMessageIds)
          ? value.processedMessageIds.filter((id): id is string => typeof id === 'string').slice(-500)
          : [],
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return EMPTY_STATE
      throw new Error('saved WeChat state could not be read')
    }
  }

  async writeState(state: WechatState): Promise<void> {
    await this.writeJson(this.statePath, {
      ...state,
      recentSessions: state.recentSessions.slice(0, 20),
      processedMessageIds: state.processedMessageIds.slice(-500),
    })
  }

  async removeCredentialsAndCursor(): Promise<void> {
    await Promise.all([
      rm(this.credentialsPath, { force: true }),
      rm(this.cursorPath, { force: true }),
    ])
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await this.ensureDirectory()
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, path)
      await chmod(path, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export function resolveWechatHome(): string {
  return dirname(new WechatStore().directory)
}
