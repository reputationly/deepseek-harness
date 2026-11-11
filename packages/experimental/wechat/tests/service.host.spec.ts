import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { onTestFinished, expect, it, vi } from 'vitest'
import { IlinkClient } from '../src/protocol.ts'
import { WechatStore } from '../src/storage.ts'
import { WechatService } from '../src/index.ts'
import type { WechatStatus } from '../src/types.ts'
import { createFakeIlinkServer, respond } from './fake-ilink-server.host.ts'
import type { FakeIlinkRequest } from './fake-ilink-server.host.ts'

const injectedServices = ['agents', 'workspaceRegistry', 'permissionPresets', 'canvas']

it('refreshes expired QR codes at most three times and never saves an unconfirmed login', async () => {
  let qrCount = 0
  let statusCount = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.startsWith('/ilink/bot/get_bot_qrcode')) {
      qrCount += 1
      respond(response, { ret: 0, qrcode: `qr-${qrCount}`, qrcode_img_content: 'https://example.invalid/qr' })
      return
    }
    if (request.path.startsWith('/ilink/bot/get_qrcode_status')) {
      statusCount += 1
      respond(response, { ret: 0, status: statusCount === 1 ? 'scaned' : 'expired' })
      return
    }
    respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-login-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const states: WechatStatus[] = []
  const { ctx, service } = await fixture(fake.url, store, { sleep: async () => {} }, (status) => { states.push(status) })
  cleanup.dispose = () => ctx.fiber.dispose()

  await service.startLogin()
  await vi.waitFor(async () => {
    expect(qrCount).toBe(4)
    expect((await service.getStatus()).status.state).toBe('idle')
  })
  expect(states.some(status => status.state === 'scanned')).toBe(true)
  await expect(store.readCredentials()).resolves.toBeUndefined()
})

it('filters non-owner, bot-self and group messages, persists the cursor, and deduplicates after restart', async () => {
  const batch = {
    ret: 0,
    get_updates_buf: 'opaque-cursor-1',
    msgs: [
      { message_id: 1, from_user_id: 'another-user', create_time_ms: 1, item_list: [{ type: 1, text_item: { text: '/help' } }] },
      { message_id: 2, from_user_id: 'owner-id', group_id: 'group-id', create_time_ms: 2, item_list: [{ type: 1, text_item: { text: '/help' } }] },
      { message_id: 3, from_user_id: 'bot-id', create_time_ms: 3, item_list: [{ type: 1, text_item: { text: '/help' } }] },
      { message_id: 4, from_user_id: 'owner-id', create_time_ms: 4, item_list: [{ type: 1, text_item: { text: '/help' } }] },
      { message_id: 5, from_user_id: 'owner-id', create_time_ms: 5, item_list: [{ type: 1, text_item: { text: '/project' } }] },
      { message_id: 6, from_user_id: 'owner-id', create_time_ms: Date.now() + 1_000_000, item_list: [{ type: 1, text_item: { text: '/help' } }] },
    ],
  }
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) {
      respond(response, { ret: 0 })
    } else if (request.path.endsWith('/getconfig')) {
      respond(response, { ret: 0, typing_ticket: 'typing-ticket' })
    } else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1 || updateCalls === 3) respond(response, batch)
    } else if (request.path.endsWith('/sendmessage')) {
      respond(response, { ret: 0 })
    } else {
      respond(response, { ret: 0 })
    }
  })
  const cleanup: { home?: string; disposeFirst?: () => Promise<void>; disposeSecond?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.disposeSecond?.()
    await cleanup.disposeFirst?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cursor-'))
  cleanup.home = home
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  await store.writeCursor('old-cursor')
  const first = await fixture(fake.url, store, { sleep: async () => {} })
  cleanup.disposeFirst = () => first.ctx.fiber.dispose()

  await vi.waitFor(async () => {
    expect(updateCalls).toBeGreaterThanOrEqual(2)
    expect(await store.readCursor()).toBe('opaque-cursor-1')
  })
  const replies = () => fake.requests.filter(request => request.path.endsWith('/sendmessage'))
  await vi.waitFor(() => { expect(replies()).toHaveLength(4) })
  expect(replies().map(request => (
    (request.body.msg as { item_list: Array<{ text_item: { text: string } }> }).item_list[0]?.text_item.text
  )))
    .toEqual([
      '补收到 2 条离线消息，开始处理',
      '/new · /list · /use <n> · /项目 [名称|序号]（/project）· /cancel · /help',
      '1. 微信',
      '/new · /list · /use <n> · /项目 [名称|序号]（/project）· /cancel · /help',
    ])
  expect(fake.requests.filter(request => request.path.endsWith('/getupdates'))[0]?.body.get_updates_buf).toBe('old-cursor')
  const saved = await store.readState()
  expect(saved.processedMessageIds).toContain('4')
  expect(saved.processedMessageIds).toContain('6')
  await first.ctx.fiber.dispose()
  delete cleanup.disposeFirst

  const second = await fixture(fake.url, store, { sleep: async () => {} })
  cleanup.disposeSecond = () => second.ctx.fiber.dispose()
  await vi.waitFor(() => {
    expect(updateCalls).toBeGreaterThanOrEqual(4)
    expect(fake.requests.filter(request => request.path.endsWith('/getupdates'))[2]?.body.get_updates_buf)
      .toBe('opaque-cursor-1')
  })
  expect(replies()).toHaveLength(4)
  await second.ctx.fiber.dispose()
  delete cleanup.disposeSecond
})

it('enters reconnecting after five failures and returns to connected after recovery', async () => {
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls <= 5) respond(response, { ret: -3, errmsg: 'sensitive remote detail' })
      else if (updateCalls === 6) respond(response, { ret: 0, get_updates_buf: 'recovered', msgs: [] })
    } else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-retry-'))
  cleanup.home = home
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  const states: WechatStatus[] = []
  const harness = await fixture(fake.url, store, { sleep: async () => {} }, (status) => { states.push(status) })
  cleanup.dispose = async () => {
    harness.unlisten()
    await harness.ctx.fiber.dispose()
  }

  await vi.waitFor(() => { expect(updateCalls).toBeGreaterThanOrEqual(7) })
  const reconnecting = states.findIndex(status => status.state === 'reconnecting')
  expect(reconnecting).toBeGreaterThanOrEqual(0)
  expect(states.slice(reconnecting + 1).some(status => status.state === 'connected')).toBe(true)
  expect(JSON.stringify(states)).not.toContain('sensitive remote detail')
  expect(JSON.stringify(states)).not.toContain('private-token')
  const status = await harness.service.getStatus()
  expect(status.status.state).toBe('connected')
  if (status.status.state !== 'connected') throw new Error('the service did not return to connected')
  expect(status.status.botId).not.toBe('bot-id')
  expect(states.some(status => status.state === 'logged-out')).toBe(false)
})

it('logs out when iLink reports an expired session and clears the cursor', async () => {
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) respond(response, { ret: -14, errmsg: 'private token detail' })
    else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-expired-'))
  cleanup.home = home
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  await store.writeCursor('cursor-to-clear')
  const harness = await fixture(fake.url, store, { sleep: async () => {} })
  cleanup.dispose = () => harness.ctx.fiber.dispose()

  await vi.waitFor(async () => { expect((await harness.service.getStatus()).status.state).toBe('logged-out') })
  await expect(store.readCredentials()).resolves.toBeUndefined()
  await expect(store.readCursor()).resolves.toBe('')
})

it('processes commands FIFO and reports the saved path when a workspace file exceeds 20 MB', async () => {
  const commands = ['/new', '/list', '/use 1', '/cancel', '/项目 1']
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'commands-cursor',
        msgs: commands.map((text, index) => ({
          message_id: index + 10,
          from_user_id: 'owner-id',
          create_time_ms: index + 1,
          item_list: [{ type: 1, text_item: { text } }],
        })),
      })
    } else if (request.path.endsWith('/sendmessage')) respond(response, { ret: 0 })
    else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string } = {}
  const disposers: Array<() => Promise<void>> = []
  onTestFinished(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-commands-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  await seedCredentials(store, projectPath)
  await mkdir(projectPath, { recursive: true })
  const largeFile = join(projectPath, 'large.bin')
  await writeFile(largeFile, Buffer.alloc(20 * 1024 * 1024 + 1))
  let fileTool: FakeFileTool | undefined
  const agents = createFakeAgents((tool) => { fileTool = tool })
  const harness = await fixture(fake.url, store, { sleep: async () => {}, agents: agents.service })
  disposers.push(async () => {
    await harness.ctx.fiber.dispose()
    await agents.dispose()
  })

  await vi.waitFor(() => { expect(sentTexts(fake.requests)).toHaveLength(commands.length) })
  expect(sentTexts(fake.requests)).toEqual([
    '当前：微信 · 微信 · 新会话',
    '1. 微信 · 新会话 · project',
    '当前：微信 · 微信 · 新会话',
    '已取消当前任务',
    '当前：微信 · 微信 · 新会话',
  ])
  expect(agents.registeredToolNames).toContain('wechat_send_file')
  expect(fileTool).toBeDefined()
  expect(agents.createErrors).toEqual([])
  expect(fileTool).toMatchObject({
    description: "Send a file from the workspace to the user's WeChat. Only available in sessions that came from WeChat. Images are sent as images, videos as videos, anything else as a file. Images, videos and audio produced by generation tools in this turn are sent automatically at turn end; do not send them again. Limit 20 MB per file; larger videos are compressed first and otherwise rejected.",
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative or absolute path of the file to send.' },
      caption: { type: 'string', description: 'Short text sent before the file.' },
    },
  })
  expect(fileTool?.parameters.caption).not.toHaveProperty('required')
  await expect(fileTool!.execute({ path: largeFile })).rejects.toThrow('微信文件发送失败')
  expect(sentTexts(fake.requests).at(-1))
    .toBe('文件太大（20.0 MB），没法通过微信发送，已保存在电脑上：项目「微信」/large.bin')
  await agents.dispose()
  expect(agents.toolDisposals).toBe(2)
})

it('keeps incoming agent messages FIFO while the current WeChat turn is still running', async () => {
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0, typing_ticket: 'ticket' })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'queue-cursor',
        msgs: ['first', 'second'].map((text, index) => ({
          message_id: index + 20,
          from_user_id: 'owner-id',
          context_token: `context-${text}`,
          item_list: [{ type: 1, text_item: { text } }],
        })),
      })
    } else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void>; disposeAgents?: () => Promise<void> } = {}
  const firstStarted = deferred()
  const releaseFirst = deferred()
  onTestFinished(async () => {
    releaseFirst.resolve()
    await cleanup.dispose?.()
    await cleanup.disposeAgents?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-queue-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  await seedCredentials(store, projectPath)
  const observed: string[] = []
  const agents = createFakeAgents(() => {}, async (_agent, message, events) => {
    const text = userText(message)
    observed.push(text)
    if (text === 'first') {
      firstStarted.resolve()
      await releaseFirst.promise
    }
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `reply:${text}` }] } } })
  })
  const harness = await fixture(fake.url, store, { sleep: async () => {}, agents: agents.service })
  cleanup.dispose = () => harness.ctx.fiber.dispose()
  cleanup.disposeAgents = () => agents.dispose()

  await vi.waitFor(() => { expect(agents.createCalls).toBeGreaterThan(0) })
  expect(agents.createErrors).toEqual([])
  await firstStarted.promise
  await vi.waitFor(async () => {
    expect((await store.readState()).processedMessageIds).toEqual(['20', '21'])
  })
  expect(observed).toEqual(['first'])
  releaseFirst.resolve()
  await vi.waitFor(() => { expect(observed).toEqual(['first', 'second']) })
  await vi.waitFor(() => { expect(sentTexts(fake.requests)).toEqual(['reply:first', 'reply:second']) })
  expect(fake.requests.filter(request => request.path.endsWith('/sendmessage'))
    .map(request => asRecord(request.body.msg)?.context_token))
    .toEqual(['context-first', 'context-second'])
})

it.each([
  ['同意', 'allowed-once'],
  ['拒绝', 'rejected'],
] as const)('forwards WeChat approval decision %s', async (decision, expected) => {
  let pendingPoll: import('node:http').ServerResponse | undefined
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) pendingPoll = response
    else if (request.path.endsWith('/sendmessage')) {
      respond(response, { ret: 0 })
      if (pendingPoll !== undefined) {
        const poll = pendingPoll
        pendingPoll = undefined
        respond(poll, {
          ret: 0,
          get_updates_buf: 'approval-cursor',
          msgs: [{
            message_id: 44,
            from_user_id: 'owner-id',
            item_list: [{ type: 1, text_item: { text: decision } }],
          }],
        })
      }
    } else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-approval-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  await seedCredentials(store, projectPath)
  const sessionId = SessionId('approval-session')
  await store.writeState({
    defaultProjectPath: projectPath,
    currentSessionId: sessionId,
    recentSessions: [{ sessionId, title: '微信 · Approval', projectPath, updatedAt: 1 }],
    processedMessageIds: [],
  })
  const harness = await fixture(fake.url, store, { sleep: async () => {} })
  cleanup.dispose = () => harness.ctx.fiber.dispose()

  await vi.waitFor(() => { expect(pendingPoll).toBeDefined() })
  const request: ApprovalRequest = {
    agent: { session: { id: sessionId } } as never,
    toolName: 'write_file',
    reason: 'Update the project file',
  }
  const result = harness.serviceContext.waterfall('approval/request', request, async (): Promise<ApprovalOutcome> => 'unavailable')
  await vi.waitFor(() => { expect(sentTexts(fake.requests)).toContain('需要你确认：Update the project file\n回复「同意」或「拒绝」') })
  await expect(result).resolves.toBe(expected)
})

it('rejects a WeChat approval request after the five-minute deadline', async () => {
  const scheduled: Array<() => void> = []
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) return
    else if (request.path.endsWith('/sendmessage')) respond(response, { ret: 0 })
    else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-approval-timeout-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  await seedCredentials(store, projectPath)
  const sessionId = SessionId('approval-timeout-session')
  await store.writeState({
    defaultProjectPath: projectPath,
    currentSessionId: sessionId,
    recentSessions: [{ sessionId, title: '微信 · Approval', projectPath, updatedAt: 1 }],
    processedMessageIds: [],
  })
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    schedule: (callback, milliseconds) => {
      expect(milliseconds).toBe(5 * 60_000)
      scheduled.push(callback)
      return setTimeout(() => {}, milliseconds)
    },
  })
  cleanup.dispose = () => harness.ctx.fiber.dispose()
  const request: ApprovalRequest = {
    agent: { session: { id: sessionId } } as never,
    toolName: 'write_file',
    reason: 'Update the project file',
  }
  const result = harness.serviceContext.waterfall('approval/request', request, async (): Promise<ApprovalOutcome> => 'unavailable')
  await vi.waitFor(() => { expect(sentTexts(fake.requests)).toContain('需要你确认：Update the project file\n回复「同意」或「拒绝」') })
  scheduled[0]?.()
  await expect(result).resolves.toBe('rejected')
  expect(sentTexts(fake.requests)).toContain('审批已超时，按拒绝处理')
})

async function fixture(
  baseUrl: string,
  store: WechatStore,
  dependencies: {
    readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
    readonly schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>
    readonly agents?: object
  },
  onStatus?: (status: WechatStatus) => void,
) {
  const ctx = new Context()
  const unlisten = onStatus === undefined ? () => {} : ctx.on('wechat/status', onStatus)
  const { agents, ...serviceDependencies } = dependencies
  ctx.provide('agents', (agents ?? { get: () => undefined, create: async () => { throw new Error('unexpected agent creation') } }) as never)
  ctx.provide('workspaceRegistry', {
    resolveByPath: async (path: string) => ({ id: 'wechat-project', path, title: '微信' }),
    create: async (path: string, title: string) => ({ id: 'wechat-project', path, title }),
    list: () => [{ id: 'wechat-project', path: join(store.directory, 'project'), title: '微信' }],
  } as never)
  ctx.provide('permissionPresets', { set: async () => {} } as never)
  ctx.provide('canvas', { edit: async () => {} } as never)
  let service!: WechatService
  let serviceContext!: Context
  const plugin = ctx.plugin({
    inject: injectedServices,
    apply: (scope) => {
      serviceContext = scope
      service = new WechatService(scope, {
        store,
        createClient: (_url, token) => new IlinkClient(baseUrl, token),
        ...serviceDependencies,
      })
    },
  })
  await plugin
  return { ctx, service, serviceContext, unlisten }
}

async function seedCredentials(store: WechatStore, projectPath: string): Promise<void> {
  await store.writeCredentials({ token: 'private-token', baseUrl: 'https://ilink.example', botId: 'bot-id', ownerUserId: 'owner-id' })
  await store.writeState({ defaultProjectPath: projectPath, recentSessions: [], processedMessageIds: [] })
}

interface FakeFileTool {
  readonly name: 'wechat_send_file'
  readonly description: string
  readonly parameters: {
    readonly path: { readonly type: 'string'; readonly required: true; readonly description: string }
    readonly caption: { readonly type: 'string'; readonly description: string }
  }
  execute(args: { readonly path: string; readonly caption?: string }): Promise<unknown>
}

interface FakeAgent {
  readonly ctx: Context
  readonly session: {
    readonly id: SessionId
    readonly header: { readonly cwd: string }
    readonly seq: number
  }
  followup(message: unknown): void
  whenIdle(): Promise<void>
  cancel(): void
}

interface FakeCreateOptions {
  readonly sessionId: SessionId
  readonly meta: { readonly cwd: string }
  readonly setup: (ctx: Context, agent: never) => Promise<void>
}

function createFakeAgents(
  onTool: (tool: FakeFileTool) => void,
  onFollowup?: (agent: FakeAgent, message: unknown, events: unknown[]) => Promise<void>,
): {
  readonly service: object
  readonly toolDisposals: number
  readonly createCalls: number
  readonly createErrors: string[]
  readonly registeredToolNames: string[]
  dispose(): Promise<void>
} {
  const agents = new Map<string, FakeAgent>()
  const contexts: Context[] = []
  let toolDisposals = 0
  let createCalls = 0
  const createErrors: string[] = []
  const registeredToolNames: string[] = []
  let disposed = false
  return {
    service: {
      get: (sessionId: string) => agents.get(sessionId),
      create: async (options: FakeCreateOptions) => {
        createCalls += 1
        const events: unknown[] = []
        const agentContext = new Context()
        let activity = Promise.resolve()
        const agent: FakeAgent = {
          ctx: agentContext,
          session: {
            id: options.sessionId,
            header: { cwd: options.meta.cwd },
            get seq() { return events.length },
          },
          followup: (message) => {
            const firstNewEvent = events.length
            activity = Promise.resolve(onFollowup?.(agent, message, events)).then(() => {
              for (let index = firstNewEvent; index < events.length; index += 1) {
                const value = asRecord(events[index])
                if (value === undefined) continue
                const event = { ...value, seq: index, time: Date.now() }
                events[index] = event
                agentContext.emit('session/event', agent.session as never, event as never)
              }
            })
          },
          whenIdle: () => activity,
          cancel: () => {},
        }
        contexts.push(agentContext)
        agentContext.provide('tools', {
          register(value: unknown) {
            const name = asRecord(value)?.name
            if (typeof name === 'string') registeredToolNames.push(name)
            const tool = fileTool(value)
            if (tool === undefined) return () => {}
            onTool(tool)
            return () => { toolDisposals += 1 }
          },
        } as never)
        try {
          await options.setup(agentContext, agent as never)
        } catch (error) {
          createErrors.push(error instanceof Error ? error.message.replaceAll('private-token', '[redacted]') : typeof error)
          throw error
        }
        agents.set(String(options.sessionId), agent)
        return { agent, dispose: async () => { await agentContext.fiber.dispose() } }
      },
      resume: async () => { throw new Error('unexpected agent resume') },
    },
    get toolDisposals() { return toolDisposals },
    get createCalls() { return createCalls },
    createErrors,
    registeredToolNames,
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const context of contexts) await context.fiber.dispose()
    },
  }
}

function fileTool(value: unknown): FakeFileTool | undefined {
  const candidate = asRecord(value)
  const parameters = asRecord(candidate?.parameters)
  const properties = asRecord(parameters?.properties)
  const path = asRecord(properties?.path)
  const caption = asRecord(properties?.caption)
  const required = parameters?.required
  if (candidate?.name !== 'wechat_send_file' || typeof candidate.description !== 'string'
    || typeof candidate.execute !== 'function'
    || !Array.isArray(required) || !required.includes('path') || required.includes('caption')
    || path?.type !== 'string' || typeof path.description !== 'string'
    || caption?.type !== 'string' || typeof caption.description !== 'string') {
    return undefined
  }
  const execute = candidate.execute
  return {
    name: 'wechat_send_file',
    description: candidate.description,
    parameters: {
      path: { type: 'string', required: true, description: path.description },
      caption: { type: 'string', description: caption.description },
    },
    execute: args => Promise.resolve(execute.call(value, args)),
  }
}

function userText(value: unknown): string {
  const content = asRecord(value)?.content
  if (!Array.isArray(content)) return ''
  return content.map((item) => {
    const block = asRecord(item)
    return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
  }).join('\n')
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function sentTexts(requests: readonly FakeIlinkRequest[]): string[] {
  return requests.filter(request => request.path.endsWith('/sendmessage')).map((request) => {
    const message = asRecord(request.body.msg)
    const items = message?.item_list
    const first = Array.isArray(items) ? asRecord(items[0]) : undefined
    const text = asRecord(first?.text_item)?.text
    if (typeof text !== 'string') throw new Error('fake iLink server received a non-text sendmessage')
    return text
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
