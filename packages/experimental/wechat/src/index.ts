/**
 * Local Tencent iLink binding for WeChat-origin DSH agent sessions.
 * @module @deepseek-ai/dsh-wechat
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionId as SessionIdType, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-canvas'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-workspace'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { WechatCredentials, WechatState } from './storage.ts'
import { WechatStore as Store } from './storage.ts'
import {
  ILINK_BASE_URL, IlinkApiError, IlinkClient, ITEM_TYPE, MAX_OUTBOUND_BYTES, assertSuccess, isExpiredSession, isTimeoutError,
  maskId, messageId, messageText, redact, safeFilename, voiceTranscript,
} from './protocol.ts'
import type { IlinkEnvelope, IlinkItem, IlinkMessage } from './protocol.ts'
import type { WechatProject, WechatRecentSession, WechatSnapshot, WechatStatus } from './types.ts'

export type * from './types.ts'

const execFileAsync = promisify(execFile)
const MAX_RECENT_SESSIONS = 20
const QR_REFRESH_LIMIT = 3
const RETRY_LIMIT = 5
const TYPING_INTERVAL_MS = 7_000
const APPROVAL_TIMEOUT_MS = 5 * 60_000
const HISTORY_LIMIT = 500
const DEFAULT_WECHAT_TITLE = '微信 · 新会话'
const FILE_TOOL_DESCRIPTION = "Send a file from the workspace to the user's WeChat. Only available in sessions that came from WeChat. Images are sent as images, videos as videos, anything else as a file. Images, videos and audio produced by generation tools in this turn are sent automatically at turn end; do not send them again. Limit 20 MB per file; larger videos are compressed first and otherwise rejected."

interface WechatServiceDependencies {
  readonly store?: Store
  readonly createClient?: (baseUrl: string, token?: string) => IlinkClient
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  readonly schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>
  readonly runFfmpeg?: (arguments_: readonly string[]) => Promise<void>
}

interface PendingApproval {
  readonly decide: (outcome: ApprovalOutcome) => void
}

type QueuedMessage =
  | {
    readonly kind: 'agent'
    readonly message: IlinkMessage
    readonly text: string
    readonly imageAttachments: readonly string[]
    readonly contextToken?: string
  }
  | { readonly kind: 'command'; readonly text: string; readonly contextToken?: string }

/** Owns QR login, the durable iLink cursor, and the WeChat-to-Agent bridge. */
export class WechatService extends TypertRemoteService {
  static inject = ['agents', 'agentDefaultModel', 'workspaceRegistry', 'permissionPresets']

  private readonly store: Store
  private loadTask: Promise<void> | undefined
  private status: WechatStatus = { state: 'idle' }
  private lastError: string | undefined
  private credentials: WechatCredentials | undefined
  private state: WechatState = { recentSessions: [], processedMessageIds: [] }
  private cursor = ''
  private client: IlinkClient | undefined
  private transportController: AbortController | undefined
  private loginController: AbortController | undefined
  private transportTask: Promise<void> | undefined
  private loginTask: Promise<void> | undefined
  private stateWrite = Promise.resolve()
  private readonly statusListeners = new Set<(status: WechatStatus) => void>()
  private readonly queue: QueuedMessage[] = []
  private queueTask: Promise<void> | undefined
  private currentHandle: AgentHandle | undefined
  private ownedHandle: AgentHandle | undefined
  private activeContextToken: string | undefined
  private typingTicket: string | undefined
  private currentTyping: ReturnType<typeof setInterval> | undefined
  private readonly pendingApprovals = new Map<SessionIdType, PendingApproval>()
  private readonly seen = new Set<string>()
  private readonly createClient: (baseUrl: string, token?: string) => IlinkClient
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  private readonly schedule: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>
  private readonly runFfmpeg: (arguments_: readonly string[]) => Promise<void>

  constructor(ctx: Context, dependencies: WechatServiceDependencies = {}) {
    super(ctx, 'wechat')
    this.store = dependencies.store ?? new Store()
    this.createClient = dependencies.createClient ?? ((baseUrl, token) => new IlinkClient(baseUrl, token))
    this.sleep = dependencies.sleep ?? delay
    this.schedule = dependencies.schedule ?? setTimeout
    this.runFfmpeg = dependencies.runFfmpeg
      ?? (arguments_ => execFileAsync('ffmpeg', [...arguments_], { timeout: 120_000 }).then(() => undefined))
    ctx.effect(() => this.activate(), 'wechat iLink lifecycle')
    ctx.on('approval/request', (request, next) => this.onApproval(request, next))
  }

  /** Read the sanitized current state for the local settings page. */
  @Remote
  async getStatus(): Promise<WechatSnapshot> {
    await this.ensureLoaded()
    return this.snapshot()
  }

  /** Open a new local QR login and begin polling its status. */
  @Remote
  async startLogin(): Promise<WechatSnapshot> {
    await this.ensureLoaded()
    await this.stopLogin()
    this.lastError = undefined
    const controller = new AbortController()
    this.loginController = controller
    const qrClient = this.createClient(ILINK_BASE_URL)
    try {
      const qr = await qrClient.getQr(controller.signal)
      this.setStatus({ state: 'qr-pending', qrDataUrl: qr.qrDataUrl, expiresAt: Date.now() + 180_000 })
      this.loginTask = this.pollQr(qr.qrcode, controller.signal)
    } catch (error) {
      this.lastError = safePublicError(error)
      this.setStatus({ state: 'idle' })
      throw new Error(this.lastError)
    }
    return this.snapshot()
  }

  /** Cancel the pending QR login without removing saved credentials. */
  @Remote
  async cancelLogin(): Promise<WechatSnapshot> {
    await this.stopLogin()
    this.lastError = undefined
    this.setStatus({ state: 'idle' })
    return this.snapshot()
  }

  /** Reconnect using the saved iLink credentials. */
  @Remote
  async reconnect(): Promise<WechatSnapshot> {
    await this.ensureLoaded()
    if (this.credentials === undefined) {
      this.setStatus({ state: 'logged-out' })
      return this.snapshot()
    }
    await this.stopTransport()
    this.startTransport()
    return this.snapshot()
  }

  /** Stop polling while retaining credentials for a later reconnect. */
  @Remote
  async disconnect(): Promise<WechatSnapshot> {
    await this.stopTransport()
    this.setStatus({ state: 'idle' })
    return this.snapshot()
  }

  /** Delete the saved iLink token and cursor and stop the local connection. */
  @Remote
  async logout(): Promise<WechatSnapshot> {
    await this.stopLogin()
    await this.stopTransport()
    await this.store.removeCredentialsAndCursor()
    this.credentials = undefined
    this.client = undefined
    this.typingTicket = undefined
    this.cursor = ''
    this.setStatus({ state: 'logged-out' })
    return this.snapshot()
  }

  /** Select an existing registered project as the default WeChat workspace. */
  @Remote
  async setDefaultProject(projectPath: string): Promise<WechatSnapshot> {
    const project = await this.ctx.workspaceRegistry.resolveByPath(projectPath)
    if (project === undefined) throw new Error('请选择一个已存在的项目')
    const currentSessionId = this.state.currentSessionId
    const currentRecent = this.state.recentSessions.find(item => item.sessionId === currentSessionId)
    const currentHandle = this.ownedHandle?.agent.session.id === currentSessionId
      ? this.ownedHandle
      : this.currentHandle?.agent.session.id === currentSessionId ? this.currentHandle : undefined
    const currentProjectPath = currentRecent?.projectPath ?? currentHandle?.agent.session.header.cwd
    const switchesSession = currentSessionId !== undefined && currentProjectPath !== project.path
    this.state = switchesSession
      ? {
        defaultProjectPath: project.path,
        recentSessions: this.state.recentSessions,
        processedMessageIds: this.state.processedMessageIds,
      }
      : { ...this.state, defaultProjectPath: project.path }
    await this.persistState()
    if (switchesSession) {
      await this.queueTask
      await this.releaseOwnedHandle(currentSessionId)
    }
    return this.snapshot()
  }

  /** Stream sanitized status changes to the settings page. */
  @Remote({ mode: 'stream' })
  async *watchStatus(signal: AbortSignal): AsyncIterable<WechatStatus> {
    const pending: WechatStatus[] = []
    let wake: (() => void) | undefined
    const listener = (status: WechatStatus): void => {
      pending.push(status)
      wake?.()
    }
    const onAbort = (): void => wake?.()
    this.statusListeners.add(listener)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      yield this.status
      while (!signal.aborted) {
        const next = pending.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        await new Promise<void>((resolveWait) => {
          wake = resolveWait
        })
        wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.statusListeners.delete(listener)
    }
  }

  private async activate(): Promise<() => Promise<void>> {
    await this.ensureLoaded()
    if (this.credentials !== undefined) this.startTransport()
    return async () => {
      await this.stopLogin()
      await this.stopTransport()
      if (this.currentTyping !== undefined) clearInterval(this.currentTyping)
      this.currentTyping = undefined
      this.queue.length = 0
      this.currentHandle?.agent.cancel({ kind: 'user' })
      for (const pending of this.pendingApprovals.values()) pending.decide('rejected')
      this.pendingApprovals.clear()
      await this.queueTask
      await this.releaseOwnedHandle()
    }
  }

  private ensureLoaded(): Promise<void> {
    if (this.loadTask !== undefined) return this.loadTask
    this.loadTask = this.loadState()
    return this.loadTask
  }

  private async loadState(): Promise<void> {
    await this.store.ensureDirectory()
    try {
      this.credentials = await this.store.readCredentials()
      this.state = await this.store.readState()
      this.cursor = await this.store.readCursor()
      if (this.credentials !== undefined) this.client = this.createClient(this.credentials.baseUrl, this.credentials.token)
    } catch (error) {
      this.ctx.logger.warn(`wechat: saved state could not be loaded (${safePublicError(error)})`)
      this.credentials = undefined
      this.client = undefined
      this.lastError = '无法读取微信登录状态，请重新扫码'
      this.setStatus({ state: 'logged-out' })
    }
  }

  private async pollQr(initialCode: string, signal: AbortSignal): Promise<void> {
    let code = initialCode
    let baseUrl = 'https://ilinkai.weixin.qq.com'
    let refreshes = 0
    try {
      while (!signal.aborted) {
        const response = await this.createClient(baseUrl).getQrStatus(code, '', signal)
        assertSuccess(response)
        const state = typeof response.status === 'string' ? response.status : 'wait'
        if (state === 'scaned' || state === 'scaned_but_redirect') {
          if (this.status.state !== 'scanned') this.setStatus({ state: 'scanned' })
          if (state === 'scaned_but_redirect' && typeof response.redirect_host === 'string') {
            baseUrl = `https://${response.redirect_host}`
          }
          continue
        }
        if (state === 'expired') {
          if (refreshes >= QR_REFRESH_LIMIT) {
            this.lastError = '二维码已多次过期，请重新点击添加微信'
            this.setStatus({ state: 'idle' })
            return
          }
          refreshes += 1
          const qr = await this.createClient(ILINK_BASE_URL).getQr(signal)
          code = qr.qrcode
          baseUrl = 'https://ilinkai.weixin.qq.com'
          this.lastError = undefined
          this.setStatus({ state: 'qr-pending', qrDataUrl: qr.qrDataUrl, expiresAt: Date.now() + 180_000 })
          continue
        }
        if (state === 'confirmed') {
          const token = typeof response.bot_token === 'string' ? response.bot_token : ''
          const botId = typeof response.ilink_bot_id === 'string' ? response.ilink_bot_id : ''
          const ownerUserId = typeof response.ilink_user_id === 'string' ? response.ilink_user_id : ''
          if (!token || !botId || !ownerUserId) throw new Error('微信扫码确认信息不完整')
          const confirmedBase = typeof response.baseurl === 'string' ? response.baseurl : baseUrl
          const credentials = { token, baseUrl: normalizeConfirmedBase(confirmedBase), botId, ownerUserId }
          await this.store.writeCredentials(credentials)
          this.typingTicket = undefined
          this.credentials = credentials
          this.client = this.createClient(credentials.baseUrl, credentials.token)
          this.loginController = undefined
          this.setStatus({ state: 'connecting' })
          await this.ensureDefaultProject()
          this.startTransport()
          return
        }
        if (state === 'need_verifycode' || state === 'binded_redirect') {
          this.lastError = state === 'need_verifycode'
            ? '微信要求额外验证，请稍后重新扫码'
            : '此微信机器人已绑定其他设备，请先退出原设备'
          this.setStatus({ state: 'idle' })
          return
        }
        await this.sleep(500, signal)
      }
    } catch (error) {
      if (isAborted(signal)) return
      this.lastError = safePublicError(error)
      this.ctx.logger.warn(`wechat: QR login failed (${redact(this.lastError)})`)
      this.setStatus({ state: 'idle' })
    }
  }

  private startTransport(): void {
    if (this.credentials === undefined || this.transportTask !== undefined) return
    this.client = this.createClient(this.credentials.baseUrl, this.credentials.token)
    const controller = new AbortController()
    this.transportController = controller
    this.setStatus({ state: 'connecting' })
    this.transportTask = this.runTransport(controller.signal).finally(() => {
      if (this.transportController === controller) this.transportController = undefined
      this.transportTask = undefined
    })
  }

  private async runTransport(signal: AbortSignal): Promise<void> {
    const credentials = this.credentials
    const client = this.client
    if (credentials === undefined || client === undefined) return
    const startedAt = Date.now()
    let failures = 0
    let firstBatch = true
    let cursor = this.cursor
    let step = 'ilink/bot/msg/notifystart'
    while (!signal.aborted) {
      try {
        step = 'ilink/bot/msg/notifystart'
        await client.notifyStart(signal)
        this.lastError = undefined
        this.setStatus({ state: 'connected', botId: maskId(credentials.botId) })
        step = 'wechat.ensureDefaultProject'
        await this.ensureDefaultProject()
        while (!signal.aborted) {
          let batch: IlinkEnvelope
          try {
            step = 'ilink/bot/getupdates'
            batch = await client.getUpdates(cursor, signal)
          } catch (error) {
            if (isAborted(signal)) return
            if (isTimeoutError(error)) continue
            throw error
          }
          if (Number(batch.ret ?? 0) !== 0 || Number(batch.errcode ?? 0) !== 0) {
            throw new IlinkApiError(
              `iLink rejected updates (ret=${batch.ret ?? 'none'}, errcode=${batch.errcode ?? 'none'})`,
              batch.ret,
              batch.errcode,
            )
          }
          failures = 0
          this.lastError = undefined
          if (this.status.state !== 'connected') this.setStatus({ state: 'connected', botId: maskId(credentials.botId) })
          const messages = Array.isArray(batch.msgs) ? batch.msgs.filter(isMessage) : []
          const pendingMessages = messages.filter((message) => {
            const from = message.from_user_id ?? ''
            const id = messageId(message)
            return !message.group_id && from === credentials.ownerUserId && from !== credentials.botId
              && id !== '' && !this.seen.has(id) && !this.state.processedMessageIds.includes(id)
              && createdBefore(message, startedAt)
          })
          if (firstBatch && cursor && pendingMessages.length > 0) {
            step = 'ilink/bot/sendmessage (offline notice)'
            await this.sendText(`补收到 ${pendingMessages.length} 条离线消息，开始处理`)
          }
          firstBatch = false
          for (const message of messages) {
            if (isAborted(signal)) return
            step = 'wechat.receiveMessage'
            await this.receiveMessage(message, signal)
          }
          if (typeof batch.get_updates_buf === 'string') {
            cursor = batch.get_updates_buf
            this.cursor = cursor
            step = 'wechat.persistCursor'
            await this.store.writeCursor(cursor)
          }
        }
      } catch (error) {
        if (isAborted(signal)) return
        const ret = error instanceof IlinkApiError ? numericApiCode(error.ret) : 'none'
        const errcode = error instanceof IlinkApiError ? numericApiCode(error.errcode) : 'none'
        this.ctx.logger.warn(`wechat: transport ${step} failed (ret=${ret} errcode=${errcode})`)
        if (isExpiredSession(error)) {
          await this.expireSession()
          return
        }
        failures += 1
        const publicError = safePublicError(error)
        if (failures >= RETRY_LIMIT) this.setStatus({ state: 'reconnecting', lastError: publicError })
        const wait = failures >= RETRY_LIMIT
          ? Math.min(3_000 * 2 ** (failures - RETRY_LIMIT), 60_000)
          : 1_000
        step = 'wechat.retryDelay'
        await this.sleep(wait, signal)
      }
    }
  }

  private async receiveMessage(message: IlinkMessage, signal: AbortSignal): Promise<void> {
    const credentials = this.credentials
    if (credentials === undefined) return
    const from = message.from_user_id ?? ''
    const id = messageId(message)
    if (message.group_id || from !== credentials.ownerUserId || from === credentials.botId) {
      this.ctx.logger.debug(`wechat: ignored message from ${maskId(from)}`)
      return
    }
    if (!id || this.seen.has(id) || this.state.processedMessageIds.includes(id)) return
    const typingTicket = await this.getTypingTicket(message, signal)
    if (signal.aborted) return
    this.seen.add(id)
    const text = messageText(message).trim()
    const pending = this.pendingApprovals.values().next().value
    if (pending !== undefined) {
      const decision = parseApprovalDecision(text)
      if (decision !== undefined) {
        pending.decide(decision)
        await this.markProcessed(id)
        return
      }
    }
    if (text.startsWith('/')) {
      if (text.trim() !== '/cancel' && (this.queueTask !== undefined || this.queue.length > 0)) {
        this.queue.push({
          kind: 'command',
          text,
          ...(message.context_token === undefined ? {} : { contextToken: message.context_token }),
        })
        await this.markProcessed(id)
        this.startQueue(typingTicket)
        return
      }
      try {
        await this.runCommand(text, message.context_token)
      } catch (error) {
        this.ctx.logger.warn(`wechat: command failed (${safePublicError(error)})`)
        await this.sendText('微信命令处理失败，请稍后重试', message.context_token)
      }
      await this.markProcessed(id)
      return
    }
    if (typingTicket) void this.client?.sendTyping(credentials.ownerUserId, typingTicket)
      .catch((error: unknown) => { this.ctx.logger.debug(`wechat: typing update failed (${safePublicError(error)})`) })
    const input = await this.buildAgentInput(message)
    if (input === undefined) {
      await this.sendText('没听清，请再说一次或打字', message.context_token)
      await this.markProcessed(id)
      return
    }
    this.queue.push({
      kind: 'agent',
      message,
      text: input.text,
      imageAttachments: input.imageAttachments,
      ...(message.context_token === undefined ? {} : { contextToken: message.context_token }),
    })
    await this.markProcessed(id)
    this.startQueue(typingTicket)
  }

  private async getTypingTicket(message: IlinkMessage, signal: AbortSignal): Promise<string | undefined> {
    const credentials = this.credentials
    const client = this.client
    if (credentials === undefined || client === undefined) return undefined
    try {
      const config = await client.getConfig(credentials.ownerUserId, message.context_token, signal)
      const ticket = typeof config.typing_ticket === 'string' && config.typing_ticket !== ''
        ? config.typing_ticket
        : undefined
      if (ticket !== undefined) this.typingTicket = ticket
      return ticket ?? this.typingTicket
    } catch (error) {
      this.ctx.logger.debug(`wechat: typing ticket unavailable (${safePublicError(error)})`)
      return undefined
    }
  }

  private async buildAgentInput(
    message: IlinkMessage,
  ): Promise<{ readonly text: string; readonly imageAttachments: readonly string[] } | undefined> {
    const project = await this.ensureDefaultProject()
    const attachments: string[] = []
    const imageAttachments: string[] = []
    let voiceWithoutTranscript = false
    const date = new Date()
    const day = date.toISOString().slice(0, 10)
    const directory = join(project.path, 'wechat-inbox', day)
    for (const [index, item] of (message.item_list ?? []).entries()) {
      const type = Number(item.type)
      if (!isAttachmentType(type)) continue
      try {
        const bytes = await this.client?.downloadMedia(item)
        if (bytes === undefined) continue
        await mkdir(directory, { recursive: true })
        const mediaItem = mediaDetails(item)
        const name = uniqueName(safeFilename(mediaItem.filename, `wechat-${type}-${index + 1}.bin`))
        const path = join(directory, name)
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
        const workspacePath = relative(project.path, path).split(sep).join('/')
        attachments.push(workspacePath)
        if (type === ITEM_TYPE.image) imageAttachments.push(workspacePath)
        if (type === ITEM_TYPE.voice && !voiceTranscript(message).trim()) voiceWithoutTranscript = true
      } catch {
        attachments.push('附件下载失败')
      }
    }
    if (voiceWithoutTranscript && messageText(message).trim() === '') return undefined
    const transcript = voiceTranscript(message).trim()
    const text = [messageText(message).trim(), transcript ? `语音转写：${transcript}` : '']
      .filter(Boolean)
      .join('\n')
    const mediaText = attachments.map(path => `附件：${path}`).join('\n')
    const input = [text, mediaText].filter(Boolean).join('\n')
    return input === '' ? undefined : { text: input, imageAttachments }
  }

  private startQueue(typingTicket?: string): void {
    if (this.queueTask !== undefined) return
    this.queueTask = this.drainQueue(typingTicket).finally(() => { this.queueTask = undefined })
  }

  private async drainQueue(typingTicket?: string): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift()
      if (next === undefined) continue
      if (next.kind === 'command') {
        this.activeContextToken = next.contextToken
        try {
          await this.runCommand(next.text, next.contextToken)
        } catch (error) {
          this.ctx.logger.warn(`wechat: command failed (${safePublicError(error)})`)
          await this.sendText('微信命令处理失败，请稍后重试', next.contextToken)
        } finally {
          this.activeContextToken = undefined
        }
        continue
      }
      try {
        const project = await this.ensureDefaultProject()
        const handle = await this.ensureCurrentSession(project.path)
        this.currentHandle = handle
        this.activeContextToken = next.contextToken
        if (typingTicket) {
          void this.client?.sendTyping(this.credentials?.ownerUserId ?? '', typingTicket)
            .catch((error: unknown) => { this.ctx.logger.debug(`wechat: typing update failed (${safePublicError(error)})`) })
          this.currentTyping = setInterval(() => {
            void this.client?.sendTyping(this.credentials?.ownerUserId ?? '', typingTicket)
              .catch((error: unknown) => { this.ctx.logger.debug(`wechat: typing update failed (${safePublicError(error)})`) })
          }, TYPING_INTERVAL_MS)
        }
        const session = handle.agent.session
        if (next.imageAttachments.length > 0) {
          const canvas = this.ctx.get('canvas')
          if (canvas === undefined) {
            this.ctx.logger.debug('wechat: canvas service unavailable; skipping image placement')
          } else {
            try {
              await canvas.edit(session, next.imageAttachments.map(path => ({
                op: 'add' as const,
                type: 'image' as const,
                title: `微信 · ${basename(path)}`,
                path,
              })))
            } catch (error) {
              this.ctx.logger.debug(`wechat: inbound image canvas placement failed (${safePublicError(error)})`)
            }
          }
        }
        this.titleFirstWechatMessage(session, next.text)
        const afterSeq = session.seq
        const events: SessionEvent[] = []
        const stopObserving = handle.agent.ctx.on('session/event', (observed, event) => {
          if (observed.id === session.id && event.seq >= afterSeq) events.push(event)
        })
        try {
          handle.agent.followup(createUserMessage({
            content: [{ type: 'text', text: next.text }],
            source: { kind: 'wechat' },
          }))
          await handle.agent.whenIdle()
        } finally {
          stopObserving()
        }
        await this.sendTurn(events, session, next.contextToken)
        await this.updateRecent(session, project.path)
      } catch (error) {
        this.ctx.logger.warn(`wechat: agent turn failed (${safePublicError(error)})`)
        await this.sendText('微信消息处理失败，请稍后重试', this.activeContextToken)
      } finally {
        if (this.currentTyping !== undefined) clearInterval(this.currentTyping)
        this.currentTyping = undefined
        this.currentHandle = undefined
        this.activeContextToken = undefined
      }
    }
  }

  private async sendTurn(
    events: readonly SessionEvent[],
    session: Session,
    contextToken?: string,
  ): Promise<void> {
    const texts = events.flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text)
      : [])
    const text = plainText(texts.join('\n').trim())
    if (text) {
      for (const part of splitText(text, 2_000)) await this.sendText(part, contextToken)
    } else await this.sendText('已完成', contextToken)

    const tools = new Map<string, string>()
    const paths = new Set<string>()
    for (const event of events) {
      if (event.type === 'tool/call') tools.set(event.data.callId, event.data.name)
      if (event.type !== 'tool/result' || !['generate_image', 'generate_video', 'generate_music', 'generate_speech'].includes(tools.get(event.data.message.toolCallId) ?? '')) continue
      const path = generatedArtifactPath(event.data.meta)
      if (path !== undefined) paths.add(path)
    }
    const root = session.header.cwd
    if (root === undefined) return
    for (const path of paths) await this.sendWorkspaceFile(path, root, undefined, contextToken)
  }

  private async runCommand(text: string, contextToken?: string): Promise<void> {
    const [command, ...args] = text.trim().split(/\s+/)
    if (command === '/help') {
      await this.sendText('/new · /list · /use <n> · /项目 [名称|序号]（/project）· /cancel · /help', contextToken)
      return
    }
    if (command === '/cancel') {
      this.currentHandle?.agent.cancel({ kind: 'user' })
      await this.sendText('已取消当前任务', contextToken)
      return
    }
    if (command === '/new') {
      const project = await this.ensureDefaultProject()
      const handle = await this.createSession(project.path)
      await this.selectSession(handle, project.path, true, contextToken)
      return
    }
    if (command === '/list') {
      const items = this.state.recentSessions.map((session, index) => `${index + 1}. ${session.title} · ${basename(session.projectPath)}`)
      await this.sendText(items.length ? items.join('\n') : '还没有微信会话', contextToken)
      return
    }
    if (command === '/use') {
      const index = Number(args[0])
      const recent = this.state.recentSessions[index - 1]
      if (!Number.isInteger(index) || recent === undefined) {
        await this.sendText('会话序号无效，请先使用 /list 查看', contextToken)
        return
      }
      const handle = await this.ensureSession(recent.sessionId, recent.projectPath)
      await this.selectSession(handle, recent.projectPath, true, contextToken)
      return
    }
    if (command === '/项目' || command === '/project') {
      const projects = this.projects()
      if (args.length === 0) {
        await this.sendText(projects.map((project, index) => `${index + 1}. ${project.title}`).join('\n') || '没有可用项目', contextToken)
        return
      }
      const term = args.join(' ')
      const index = Number(term)
      const selected = Number.isInteger(index) && index > 0
        ? projects[index - 1]
        : projects.find(project => project.title === term)
      if (selected === undefined) {
        await this.sendText('没有找到该项目', contextToken)
        return
      }
      this.state = { ...this.state, defaultProjectPath: selected.path }
      await this.persistState()
      const handle = await this.createSession(selected.path)
      await this.selectSession(handle, selected.path, true, contextToken)
      return
    }
    await this.sendText('未知命令，请发送 /help 查看用法', contextToken)
  }

  private async ensureCurrentSession(projectPath: string): Promise<AgentHandle> {
    const current = this.state.currentSessionId
    if (current !== undefined) {
      if (this.ownedHandle?.agent.session.id === current) return this.ownedHandle
      const agent = this.ctx.agents.get(current)
      if (agent !== undefined) {
        await this.releaseOwnedHandle()
        return { agent, dispose: async () => {} }
      }
      try {
        return await this.ensureSession(current, projectPath)
      } catch (error) {
        this.ctx.logger.warn(`wechat: saved session could not be resumed (${safePublicError(error)})`)
      }
    }
    const handle = await this.createSession(projectPath)
    await this.selectSession(handle, projectPath, false)
    return handle
  }

  private async ensureSession(sessionId: SessionIdType, projectPath: string): Promise<AgentHandle> {
    if (this.ownedHandle?.agent.session.id === sessionId) return this.ownedHandle
    const active = this.ctx.agents.get(sessionId)
    await this.releaseOwnedHandle()
    if (active !== undefined) return { agent: active, dispose: async () => {} }
    const recent = this.state.recentSessions.find(item => item.sessionId === sessionId)
    const presets = this.ctx.get('agentPresets')
    const agentPreset = presets === undefined
      ? undefined
      : recent?.agentPreset ?? (await presets.resolve(undefined)).id
    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: this.agentSetup(projectPath, agentPreset),
    })
    this.ownedHandle = handle
    await this.attachSessionToWorkspace(sessionId, projectPath)
    await this.updateRecent(handle.agent.session, projectPath, agentPreset)
    return handle
  }

  private async createSession(projectPath: string): Promise<AgentHandle> {
    await this.releaseOwnedHandle()
    const sessionId = SessionId(randomUUID())
    const presets = this.ctx.get('agentPresets')
    const agentPreset = presets === undefined ? undefined : (await presets.resolve(undefined)).id
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: { cwd: projectPath, ...(agentPreset === undefined ? {} : { agentPreset }) },
      setup: this.agentSetup(projectPath, agentPreset),
    })
    this.ownedHandle = handle
    await this.attachSessionToWorkspace(sessionId, projectPath)
    this.ctx.get('sessionTitle')?.rename(handle.agent.session, DEFAULT_WECHAT_TITLE)
    await this.updateRecent(handle.agent.session, projectPath, agentPreset)
    return handle
  }

  private agentOptions(): AgentOptions {
    const defaults = this.ctx.agentDefaultModel
    return {
      get provider() { return defaults.currentSelection().provider },
      get model() { return defaults.currentSelection().model },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
    }
  }

  private agentSetup(projectPath: string, agentPreset: string | undefined) {
    const presets = this.ctx.get('agentPresets')
    return async (agentCtx: Context, agent: Agent): Promise<void> => {
      installModelSelection(agentCtx)
      if (presets !== undefined && agentPreset !== undefined) await presets.mount(agentCtx, agentPreset)
      this.configureAgent(agentCtx, agent, projectPath)
    }
  }

  private async attachSessionToWorkspace(sessionId: SessionIdType, projectPath: string): Promise<void> {
    try {
      await (await this.ctx.workspaceRegistry.resolveByPath(projectPath))?.attachSession(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`wechat: Session ${sessionId} did not join the Workspace at ${projectPath}: ${String(error)}`)
    }
  }

  private configureAgent(agentCtx: Context, agent: Agent, projectPath: string): void {
    this.ctx.permissionPresets.set(agent.session, 'workspace-write')
    agentCtx.effect(() => agentCtx.tools.register(defineTool({
      name: 'wechat_send_file',
      description: FILE_TOOL_DESCRIPTION,
      parameters: {
        path: { type: 'string', required: true, description: 'Workspace-relative or absolute path of the file to send.' },
        caption: { type: 'string', description: 'Short text sent before the file.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: {
          sent: { type: 'boolean', required: true },
          fileName: { type: 'string', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        try {
          const sent = await this.sendWorkspaceFile(args.path, projectPath, args.caption, this.activeContextToken)
          if (!sent) throw new Error('文件超过微信发送限制')
        } catch (error) {
          throw new Error(`微信文件发送失败，请检查文件路径、权限和大小（${safePublicError(error)}）`)
        }
        return { sent: true, fileName: basename(args.path) }
      },
    })))
    if (agent.session.header.cwd !== projectPath) {
      throw new Error('微信会话所属项目与所选项目不一致')
    }
  }

  private titleFirstWechatMessage(session: Session, text: string): void {
    const titles = this.ctx.get('sessionTitle')
    if (titles?.get(session)?.title !== DEFAULT_WECHAT_TITLE) return
    const firstLine = Array.from(text.replace(/[\r\n]/g, '')).slice(0, 20).join('')
    if (firstLine.trim() !== '') titles.rename(session, `微信 · ${firstLine}`)
  }

  private async releaseOwnedHandle(sessionId?: SessionIdType): Promise<void> {
    const handle = this.ownedHandle
    if (handle === undefined || (sessionId !== undefined && handle.agent.session.id !== sessionId)) return
    this.ownedHandle = undefined
    try {
      await handle.dispose()
    } catch (error) {
      this.ctx.logger.warn(`wechat: agent handle disposal failed (${safePublicError(error)})`)
    }
  }

  private async selectSession(
    handle: AgentHandle,
    projectPath: string,
    reply = true,
    contextToken?: string,
  ): Promise<void> {
    this.state = { ...this.state, currentSessionId: handle.agent.session.id, defaultProjectPath: projectPath }
    await this.persistState()
    await this.updateRecent(handle.agent.session, projectPath)
    if (reply) {
      const title = this.ctx.get('sessionTitle')?.get(handle.agent.session)?.title ?? '微信 · 新会话'
      const project = this.projects().find(entry => entry.path === projectPath)
      await this.sendText(`当前：${project?.title ?? basename(projectPath)} · ${title}`, contextToken)
    }
  }

  private async updateRecent(session: Session, projectPath: string, agentPreset?: string): Promise<void> {
    const title = this.ctx.get('sessionTitle')?.get(session)?.title ?? '微信 · 新会话'
    const previous = this.state.recentSessions.find(item => item.sessionId === session.id)
    const resolvedPreset = agentPreset ?? previous?.agentPreset
    const recent: WechatRecentSession = {
      sessionId: session.id,
      title,
      projectPath,
      updatedAt: Date.now(),
      ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
    }
    this.state = {
      ...this.state,
      ...(this.state.defaultProjectPath === undefined || this.state.defaultProjectPath === projectPath
        ? { currentSessionId: session.id, defaultProjectPath: projectPath }
        : {}),
      recentSessions: [recent, ...this.state.recentSessions.filter(item => item.sessionId !== session.id)]
        .slice(0, MAX_RECENT_SESSIONS),
    }
    await this.persistState()
  }

  private async sendWorkspaceFile(
    path: string,
    projectPath: string,
    caption?: string,
    contextToken?: string,
  ): Promise<boolean> {
    const root = await realpath(projectPath)
    const requested = isAbsolute(path) ? path : resolve(root, path)
    const source = await realpath(requested)
    const relativePath = relative(root, source)
    if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error('微信文件只能从当前项目工作区发送')
    }
    const info = await stat(source)
    if (!info.isFile()) throw new Error('请选择一个普通文件')
    if (caption) await this.sendText(caption, contextToken)
    let temporaryDirectory: string | undefined
    try {
      let filePath = source
      let size = info.size
      const extension = extname(source).toLowerCase()
      let kind: 'image' | 'video' | 'file' = imageExtensions.has(extension) ? 'image' : videoExtensions.has(extension) ? 'video' : 'file'
      if (size > MAX_OUTBOUND_BYTES && kind === 'video') {
        try {
          temporaryDirectory = await mkdtemp(join(tmpdir(), 'dsh-wechat-video-'))
          const compressed = join(temporaryDirectory, 'compressed.mp4')
          await this.runFfmpeg([
            '-y', '-i', source, '-vf', 'scale=-2:min(720,ih)', '-vcodec', 'libx264', '-crf', '28', '-preset', 'fast',
            '-acodec', 'aac', '-b:a', '128k', '-movflags', '+faststart', compressed,
          ])
          const compressedStat = await stat(compressed)
          if (compressedStat.size < size) {
            filePath = compressed
            size = compressedStat.size
            kind = 'video'
          }
        } catch (error) {
          this.ctx.logger.debug(`wechat: ffmpeg compression unavailable (${safePublicError(error)})`)
        }
      }
      if (size > MAX_OUTBOUND_BYTES) {
        const project = this.projects().find(entry => entry.path === projectPath)
        const megabytes = (info.size / 1024 / 1024).toFixed(1)
        await this.sendText(`文件太大（${megabytes} MB），没法通过微信发送，已保存在电脑上：项目「${project?.title ?? basename(projectPath)}」/${relativePath.split(sep).join('/')}`, contextToken)
        return false
      }
      const bytes = await readFile(filePath)
      const filename = safeFilename(basename(filePath), 'file')
      let finalError: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const client = this.client
          const credentials = this.credentials
          if (client === undefined || credentials === undefined) throw new Error('微信尚未连接')
          await client.sendMedia(kind, filename, bytes, credentials.ownerUserId, contextToken)
          return true
        } catch (error) { finalError = error }
      }
      throw new Error(`微信文件发送失败，请稍后重试（${safePublicError(finalError)})`)
    } finally {
      if (temporaryDirectory !== undefined) {
        try {
          await rm(temporaryDirectory, { recursive: true, force: true })
        } catch (error) {
          this.ctx.logger.debug(`wechat: temporary video cleanup failed (${safePublicError(error)})`)
        }
      }
    }
  }

  private async sendText(text: string, contextToken?: string): Promise<void> {
    const client = this.client
    const credentials = this.credentials
    if (client === undefined || credentials === undefined) return
    try {
      await client.sendText(credentials.ownerUserId, text, contextToken)
    } catch (error) {
      this.ctx.logger.warn(`wechat: text delivery failed (${safePublicError(error)})`)
    }
  }

  private async ensureDefaultProject(): Promise<WechatProject> {
    let path = this.state.defaultProjectPath
    if (path === undefined) {
      path = join(this.store.directory, 'project')
      this.state = { ...this.state, defaultProjectPath: path }
      await this.persistState()
    }
    await mkdir(path, { recursive: true })
    let workspace = await this.ctx.workspaceRegistry.resolveByPath(path)
    if (workspace === undefined) workspace = await this.ctx.workspaceRegistry.create(path, '微信')
    return { id: workspace.id, title: workspace.title, path: workspace.path }
  }

  private projects(): WechatProject[] {
    return this.ctx.workspaceRegistry.list().map(workspace => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
    }))
  }

  private snapshot(): WechatSnapshot {
    const projects = this.ctx.workspaceRegistry.list().map(workspace => ({
      id: workspace.id, title: workspace.title, path: workspace.path,
    }))
    return {
      status: this.status,
      hasCredentials: this.credentials !== undefined,
      ...(this.state.defaultProjectPath === undefined ? {} : { defaultProjectPath: this.state.defaultProjectPath }),
      projects,
      ...(this.lastError === undefined ? {} : { error: this.lastError }),
    }
  }

  private setStatus(status: WechatStatus): void {
    this.status = status
    this.ctx.emit('wechat/status', status, this.lastError)
    for (const listener of this.statusListeners) listener(status)
  }

  private async expireSession(): Promise<void> {
    await this.store.removeCredentialsAndCursor()
    this.credentials = undefined
    this.client = undefined
    this.typingTicket = undefined
    this.cursor = ''
    this.setStatus({ state: 'logged-out' })
  }

  private async stopLogin(): Promise<void> {
    this.loginController?.abort()
    this.loginController = undefined
    await this.loginTask
    this.loginTask = undefined
  }

  private async stopTransport(): Promise<void> {
    const client = this.client
    if (this.transportController !== undefined && client !== undefined) {
      try {
        await client.notifyStop()
      } catch (error) {
        this.ctx.logger.debug(`wechat: iLink stop notification failed (${safePublicError(error)})`)
      }
    }
    this.transportController?.abort()
    await this.transportTask
    this.transportTask = undefined
  }

  private async markProcessed(id: string): Promise<void> {
    this.state = {
      ...this.state,
      processedMessageIds: [...this.state.processedMessageIds.filter(value => value !== id), id].slice(-HISTORY_LIMIT),
    }
    await this.persistState()
  }

  private async persistState(): Promise<void> {
    const snapshot = this.state
    this.stateWrite = this.stateWrite.then(() => this.store.writeState(snapshot))
    await this.stateWrite
  }

  private async onApproval(
    request: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    await this.ensureLoaded()
    const sessionId = request.agent.session.id
    if (this.currentHandle?.agent.session.id !== sessionId) return await next()
    const signal = request.signal
    if (signal?.aborted) return 'rejected'
    const approval = deferred<ApprovalOutcome>()
    this.pendingApprovals.set(sessionId, { decide: approval.resolve })
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let resolveAborted: (() => void) | undefined
    const aborted = new Promise<{ kind: 'aborted' }>((resolveAbort) => {
      resolveAborted = () => { resolveAbort({ kind: 'aborted' }) }
    })
    const onAbort = (): void => resolveAborted?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) resolveAborted?.()
    const timeout = new Promise<{ kind: 'timeout' }>((resolveTimeout) => {
      timeoutId = this.schedule(() =>{  resolveTimeout({ kind: 'timeout' }) }, APPROVAL_TIMEOUT_MS)
    })
    try {
      const prompt = await Promise.race([
        this.sendText(`需要你确认：${approvalSummary(request)}\n回复「同意」或「拒绝」`, this.activeContextToken)
          .then(() => ({ kind: 'sent' as const })),
        aborted,
      ])
      if (prompt.kind === 'aborted') return 'rejected'
      const delegated = next().then(value => ({ kind: 'desktop' as const, value }))
      let answer = await Promise.race([
        delegated,
        approval.promise.then(value => ({ kind: 'wechat' as const, value })),
        timeout,
        aborted,
      ])
      if (answer.kind === 'aborted') return 'rejected'
      if (answer.kind === 'desktop') {
        if (answer.value !== 'unavailable') {
          await this.sendText('已在电脑上处理', this.activeContextToken)
          return answer.value
        }
        answer = await Promise.race([
          approval.promise.then(value => ({ kind: 'wechat' as const, value })),
          timeout,
          aborted,
        ])
        if (answer.kind === 'aborted') return 'rejected'
      }
      if (answer.kind === 'wechat') return answer.value
      await this.sendText('审批已超时，按拒绝处理', this.activeContextToken)
      return 'rejected'
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      signal?.removeEventListener('abort', onAbort)
      this.pendingApprovals.delete(sessionId)
    }
  }
}

export default WechatService

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm'])

function isMessage(value: unknown): value is IlinkMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createdBefore(message: IlinkMessage, timestamp: number): boolean {
  if (message.create_time_ms === undefined) return true
  const createdAt = Number(message.create_time_ms)
  return Number.isFinite(createdAt) && createdAt <= timestamp
}

function isAttachmentType(type: number): type is typeof ITEM_TYPE.image | typeof ITEM_TYPE.voice
  | typeof ITEM_TYPE.video | typeof ITEM_TYPE.file {
  return type === ITEM_TYPE.image || type === ITEM_TYPE.voice || type === ITEM_TYPE.video || type === ITEM_TYPE.file
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function mediaDetails(item: IlinkItem): { filename: string } {
  const type = Number(item.type)
  const key = type === ITEM_TYPE.image ? 'image_item'
    : type === ITEM_TYPE.voice ? 'voice_item'
      : type === ITEM_TYPE.video ? 'video_item' : 'file_item'
  const data = record(item[key])
  const suffix = type === ITEM_TYPE.image ? '.img' : type === ITEM_TYPE.voice ? '.silk'
    : type === ITEM_TYPE.video ? '.mp4' : '.bin'
  return { filename: typeof data?.file_name === 'string' ? data.file_name : `attachment${suffix}` }
}

function uniqueName(filename: string): string {
  return `${randomUUID().slice(0, 8)}-${filename}`
}

function parseApprovalDecision(text: string): ApprovalOutcome | undefined {
  const normalized = text.trim().toLowerCase()
  if (['同意', 'y', 'yes', '1'].includes(normalized)) return 'allowed-once'
  if (['拒绝', 'n', 'no', '2'].includes(normalized)) return 'rejected'
  return undefined
}

function approvalSummary(request: ApprovalRequest): string {
  return request.reason ?? request.toolName
}

function safePublicError(error: unknown): string {
  if (error instanceof IlinkApiError) return '微信服务暂时不可用，请稍后重试'
  if (error instanceof Error && error.message.startsWith('微信')) return redact(error.message)
  return '微信连接失败，请检查网络后重试'
}

function numericApiCode(value: IlinkApiError['ret']): string {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value
  return 'none'
}

function normalizeConfirmedBase(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error()
    return `${url.toString().replace(/\/+$/, '')}/`
  } catch {
    throw new Error('iLink 登录服务地址无效')
  }
}

function plainText(value: string): string {
  return value.replace(/```[\s\S]*?```/g, match => match.replace(/```[^\n]*\n?|```/g, ''))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`>#]/g, '')
    .trim()
}

function splitText(value: string, limit: number): string[] {
  const chunks: string[] = []
  let remaining = Array.from(value)
  while (remaining.length > 0) {
    let end = Math.min(limit, remaining.length)
    if (end < remaining.length) {
      const boundary = remaining.slice(0, end).lastIndexOf('\n')
      if (boundary > limit * 0.65) end = boundary + 1
    }
    chunks.push(remaining.slice(0, end).join(''))
    remaining = remaining.slice(end)
  }
  return chunks
}

function generatedArtifactPath(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('path' in value)) return undefined
  const path = value.path
  return typeof path === 'string' && path.trim() !== '' ? path : undefined
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolveDelay()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveDelay()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
