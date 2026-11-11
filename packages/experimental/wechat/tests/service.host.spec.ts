import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { onTestFinished, expect, it, vi } from 'vitest'
import { IlinkClient, ITEM_TYPE } from '../src/protocol.ts'
import { WechatStore } from '../src/storage.ts'
import { WechatService } from '../src/index.ts'
import type { WechatStatus } from '../src/types.ts'
import { createFakeIlinkServer, respond } from './fake-ilink-server.host.ts'
import type { FakeIlinkRequest } from './fake-ilink-server.host.ts'

const injectedServices = ['agents', 'agentDefaultModel', 'workspaceRegistry', 'permissionPresets']

it('connects and polls without fetching getConfig during transport startup', async () => {
  let updateCalls = 0
  let configCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) {
      configCalls += 1
      respond(response, { ret: -4 })
    } else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, { ret: 0, get_updates_buf: 'startup-cursor', msgs: [] })
    } else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-getconfig-startup-'))
  cleanup.home = home
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  const harness = await fixture(fake.url, store, { sleep: async () => {} })
  cleanup.dispose = () => harness.ctx.fiber.dispose()

  await vi.waitFor(async () => {
    expect((await harness.service.getStatus()).status.state).toBe('connected')
    expect(updateCalls).toBeGreaterThan(0)
  })
  expect(configCalls).toBe(0)
})

it('gets a typing ticket with the inbound message context token', async () => {
  let updateCalls = 0
  const inputs: string[] = []
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0, typing_ticket: 'inbound-ticket' })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'typing-cursor',
        msgs: [{
          message_id: 89,
          from_user_id: 'owner-id',
          context_token: 'inbound-context-token',
          create_time_ms: Date.now() + 60_000,
          item_list: [{ type: 1, text_item: { text: 'hello from WeChat' } }],
        }],
      })
    } else respond(response, { ret: 0 })
  })
  const cleanup: {
    home?: string
    dispose?: () => Promise<void>
    disposeAgents?: () => Promise<void>
  } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await cleanup.disposeAgents?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-getconfig-context-'))
  cleanup.home = home
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  const agents = createFakeAgents(() => {}, async (_agent, message, events) => {
    inputs.push(userText(message))
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ack' }] } } })
  })
  const harness = await fixture(fake.url, store, { sleep: async () => {}, agents: agents.service })
  cleanup.dispose = () => harness.ctx.fiber.dispose()
  cleanup.disposeAgents = () => agents.dispose()

  await vi.waitFor(() => {
    const config = fake.requests.find(request => request.path.endsWith('/getconfig'))
    expect(config?.body.context_token).toBe('inbound-context-token')
    expect(inputs).toEqual(['hello from WeChat'])
    expect(fake.requests.some(request => (
      request.path.endsWith('/sendtyping') && request.body.typing_ticket === 'inbound-ticket'
    ))).toBe(true)
  })
})

it('continues processing an inbound message when getConfig fails', async () => {
  let updateCalls = 0
  const inputs: string[] = []
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: -4, errmsg: 'private config failure' })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'typing-failure-cursor',
        msgs: [{
          message_id: 90,
          from_user_id: 'owner-id',
          context_token: 'failure-context-token',
          create_time_ms: Date.now() + 60_000,
          item_list: [{ type: 1, text_item: { text: 'keep processing this' } }],
        }],
      })
    } else respond(response, { ret: 0 })
  })
  const cleanup: {
    home?: string
    dispose?: () => Promise<void>
    disposeAgents?: () => Promise<void>
  } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await cleanup.disposeAgents?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-getconfig-failure-'))
  cleanup.home = home
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  const agents = createFakeAgents(() => {}, async (_agent, message, events) => {
    inputs.push(userText(message))
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ack' }] } } })
  })
  const harness = await fixture(fake.url, store, { sleep: async () => {}, agents: agents.service })
  cleanup.dispose = () => harness.ctx.fiber.dispose()
  cleanup.disposeAgents = () => agents.dispose()

  await vi.waitFor(() => {
    expect(inputs).toEqual(['keep processing this'])
    expect(fake.requests.some(request => request.path.endsWith('/getconfig'))).toBe(true)
  })
  expect(fake.requests.some(request => request.path.endsWith('/sendtyping'))).toBe(false)
})

it('stores and forwards image attachments when no canvas service is installed', async () => {
  const image = Buffer.from('wechat image bytes')
  let updateCalls = 0
  let downloadCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'image-cursor',
        msgs: [{
          message_id: 88,
          from_user_id: 'owner-id',
          create_time_ms: Date.now() - 10_000,
          item_list: [{ type: ITEM_TYPE.image, image_item: {} }],
        }],
      })
    } else if (request.path.endsWith('/sendmessage')) respond(response, { ret: 0 })
    else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void>; disposeAgents?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await cleanup.disposeAgents?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-no-canvas-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  await seedCredentials(store, projectPath)
  const inputs: string[] = []
  const agents = createFakeAgents(() => {}, async (_agent, message) => {
    inputs.push(userText(message))
  })
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    agents: agents.service,
    canvas: false,
    createClient: (_baseUrl, token) => {
      const client = new IlinkClient(fake.url, token)
      vi.spyOn(client, 'downloadMedia').mockImplementation(async () => {
        downloadCalls += 1
        return image
      })
      return client
    },
  })
  cleanup.dispose = () => harness.ctx.fiber.dispose()
  cleanup.disposeAgents = () => agents.dispose()

  await vi.waitFor(async () => {
    expect((await harness.service.getStatus()).status.state).toBe('connected')
    expect(inputs).toHaveLength(1)
  })
  expect(inputs[0]).toContain('附件：wechat-inbox/')
  expect(downloadCalls).toBe(1)
  const day = (await readdir(join(projectPath, 'wechat-inbox')))[0]
  if (day === undefined) throw new Error('the WeChat inbox has no date directory')
  const file = (await readdir(join(projectPath, 'wechat-inbox', day)))[0]
  if (file === undefined) throw new Error('the downloaded image was not saved')
  await expect(readFile(join(projectPath, 'wechat-inbox', day, file))).resolves.toEqual(image)
})

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
      { message_id: 5, from_user_id: 'owner-id', create_time_ms: Date.now() + 1_000_000, item_list: [{ type: 1, text_item: { text: '/project' } }] },
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
      '补收到 1 条离线消息，开始处理',
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

it('disposes the previous owned handle on /new and the current one on service disposal', async () => {
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) respond(response, {
      ret: 0,
      get_updates_buf: 'new-session-cursor',
      msgs: ['/new', '/new'].map((text, index) => ({
        message_id: index + 60,
        from_user_id: 'owner-id',
        item_list: [{ type: 1, text_item: { text } }],
      })),
    })
    else respond(response, { ret: 0 })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-owned-handles-'))
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  const agents = createFakeAgents(() => {})
  const harness = await fixture(fake.url, store, { sleep: async () => {}, agents: agents.service })
  onTestFinished(async () => {
    await harness.ctx.fiber.dispose()
    await agents.dispose()
    await fake.close()
    await rm(home, { recursive: true, force: true })
  })

  await vi.waitFor(() => { expect(sentTexts(fake.requests)).toHaveLength(2) })
  expect(agents.createCalls).toBe(2)
  expect(agents.handleDisposals).toBe(1)
  await harness.ctx.fiber.dispose()
  expect(agents.handleDisposals).toBe(2)
})

it('gives new sessions distinct WeChat titles from their first user messages', async () => {
  const messages = ['first topic', '/new', 'second topic', '/list']
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) respond(response, {
      ret: 0,
      get_updates_buf: 'title-cursor',
      msgs: messages.map((text, index) => ({
        message_id: index + 70,
        from_user_id: 'owner-id',
        item_list: [{ type: 1, text_item: { text } }],
      })),
    })
    else respond(response, { ret: 0 })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-titles-'))
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  const titles = new Map<string, string>()
  const sessionTitle = {
    get: (session: { readonly id: string }) => ({ title: titles.get(session.id) ?? 'Automatic title' }),
    rename: (session: { readonly id: string }, title: string) => {
      titles.set(session.id, title)
      return { title }
    },
  }
  const agents = createFakeAgents(() => {}, async (_agent, _message, events) => {
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply' }] } } })
  })
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    agents: agents.service,
    sessionTitle,
  })
  onTestFinished(async () => {
    await harness.ctx.fiber.dispose()
    await agents.dispose()
    await fake.close()
    await rm(home, { recursive: true, force: true })
  })

  await vi.waitFor(() => { expect(sentTexts(fake.requests)).toHaveLength(4) })
  expect(sentTexts(fake.requests).at(-1)).toBe(
    '1. 微信 · second topic · project\n2. 微信 · first topic · project',
  )
})

it('creates sessions with default model, resolved preset, and workspace membership', async () => {
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'agent-composition-cursor',
        msgs: [{
          message_id: 901,
          from_user_id: 'owner-id',
          context_token: 'composition-context',
          create_time_ms: Date.now() + 60_000,
          item_list: [{ type: 1, text_item: { text: 'start a WeChat session' } }],
        }],
      })
    } else respond(response, { ret: 0 })
  })
  const cleanup: {
    home?: string
    dispose?: () => Promise<void>
    disposeAgents?: () => Promise<void>
  } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await cleanup.disposeAgents?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-agent-composition-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  await seedCredentials(store, projectPath)
  const attachSession = vi.fn(async (_sessionId: SessionId) => {})
  const resolve = vi.fn(async (id?: string) => ({ id: id ?? 'wechat-default' }))
  const mount = vi.fn(async (_agentCtx: Context, _id: string) => {})
  const agents = createFakeAgents(() => {})
  cleanup.disposeAgents = () => agents.dispose()
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    agents: agents.service,
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'wechat-provider', model: 'wechat-model', reasoningEffort: 'high' }),
    },
    agentPresets: { resolve, mount },
    workspaceRegistry: {
      list: () => [{ id: 'wechat-project', path: projectPath, title: '微信' }],
      create: async (path: string, title: string) => ({ id: 'wechat-project', path, title, attachSession }),
      resolveByPath: async (path: string) => path === projectPath
        ? { id: 'wechat-project', path, title: '微信', attachSession }
        : undefined,
    },
  })
  cleanup.dispose = () => harness.ctx.fiber.dispose()

  await vi.waitFor(() => { expect(agents.createOptions).toHaveLength(1) })
  const [created] = agents.createOptions
  expect(created?.agentOptions.provider).toBe('wechat-provider')
  expect(created?.agentOptions.model).toBe('wechat-model')
  expect(created?.agentOptions.reasoningEffort).toBe('high')
  expect(created?.meta.agentPreset).toBe('wechat-default')
  expect(resolve).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(mount).toHaveBeenCalledExactlyOnceWith(expect.any(Context), 'wechat-default')
  expect(attachSession).toHaveBeenCalledExactlyOnceWith(created?.sessionId)
  await expect(store.readState()).resolves.toMatchObject({
    recentSessions: [{ sessionId: created?.sessionId, agentPreset: 'wechat-default' }],
  })
})

it('creates sessions without the optional agent preset service', async () => {
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'no-preset-cursor',
        msgs: [{
          message_id: 902,
          from_user_id: 'owner-id',
          context_token: 'no-preset-context',
          create_time_ms: Date.now() + 60_000,
          item_list: [{ type: 1, text_item: { text: 'create without presets' } }],
        }],
      })
    } else respond(response, { ret: 0 })
  })
  const cleanup: {
    home?: string
    dispose?: () => Promise<void>
    disposeAgents?: () => Promise<void>
  } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await cleanup.disposeAgents?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-no-presets-'))
  cleanup.home = home
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  const agents = createFakeAgents(() => {})
  cleanup.disposeAgents = () => agents.dispose()
  const harness = await fixture(fake.url, store, { sleep: async () => {}, agents: agents.service })
  cleanup.dispose = () => harness.ctx.fiber.dispose()

  await vi.waitFor(() => { expect(agents.createOptions).toHaveLength(1) })
  const [created] = agents.createOptions
  expect(created?.agentOptions.provider).toBe('fixture-provider')
  expect(created?.agentOptions.model).toBe('fixture-model')
  expect(created?.meta).not.toHaveProperty('agentPreset')
  await expect(store.readState()).resolves.toMatchObject({
    recentSessions: [{ sessionId: created?.sessionId }],
  })
})

it('resumes a session with its recorded preset and default model', async () => {
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'resume-composition-cursor',
        msgs: [
          {
            message_id: 903,
            from_user_id: 'owner-id',
            context_token: 'resume-context',
            create_time_ms: Date.now() + 60_000,
            item_list: [{ type: 1, text_item: { text: 'continue this session' } }],
          },
          {
            message_id: 904,
            from_user_id: 'owner-id',
            context_token: 'use-context',
            create_time_ms: Date.now() + 60_000,
            item_list: [{ type: 1, text_item: { text: '/use 2' } }],
          },
        ],
      })
    } else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-resume-composition-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  await seedCredentials(store, projectPath)
  const sessionId = SessionId('stored-wechat-session')
  const legacySessionId = SessionId('legacy-wechat-session')
  await store.writeState({
    defaultProjectPath: projectPath,
    currentSessionId: sessionId,
    recentSessions: [{
      sessionId, title: '微信 · Existing', projectPath, updatedAt: 1, agentPreset: 'stored-preset',
    }, {
      sessionId: legacySessionId, title: '微信 · Legacy', projectPath, updatedAt: 2,
    }],
    processedMessageIds: [],
  })
  const resumeOptions: Array<{
    readonly resumeSessionId: SessionId
    readonly agentOptions: AgentOptions
    readonly setup: (ctx: Context, agent: never) => Promise<void>
  }> = []
  const agents = {
    get: () => undefined,
    create: async () => { throw new Error('unexpected session creation') },
    resume: async (options: (typeof resumeOptions)[number]) => {
      resumeOptions.push(options)
      const agentContext = new Context()
      agentContext.provide('tools', { register: () => () => {} } as never)
      const resumedAgent = {
        ctx: agentContext,
        signal: undefined,
        session: { id: options.resumeSessionId, header: { cwd: projectPath }, seq: 0 },
        followup: () => {},
        whenIdle: async () => {},
        cancel: () => {},
      }
      await options.setup(agentContext, resumedAgent as never)
      return {
        agent: resumedAgent,
        dispose: async () => agentContext.fiber.dispose(),
      }
    },
  }
  const attachSession = vi.fn(async (_id: SessionId) => {})
  const resolve = vi.fn(async (id?: string) => ({ id: id ?? 'default-preset' }))
  const mount = vi.fn(async (_agentCtx: Context, _id: string) => {})
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    agents,
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'resume-provider', model: 'resume-model' }),
    },
    agentPresets: { resolve, mount },
    workspaceRegistry: {
      list: () => [{ id: 'wechat-project', path: projectPath, title: '微信' }],
      create: async (path: string, title: string) => ({ id: 'wechat-project', path, title, attachSession }),
      resolveByPath: async (path: string) => path === projectPath
        ? { id: 'wechat-project', path, title: '微信', attachSession }
        : undefined,
    },
  })
  cleanup.dispose = () => harness.ctx.fiber.dispose()

  await vi.waitFor(() => { expect(resumeOptions).toHaveLength(2) })
  const [resumed, fallback] = resumeOptions
  expect(resumed?.resumeSessionId).toBe(sessionId)
  expect(resumed?.agentOptions.provider).toBe('resume-provider')
  expect(resumed?.agentOptions.model).toBe('resume-model')
  expect(fallback?.resumeSessionId).toBe(legacySessionId)
  expect(fallback?.agentOptions.provider).toBe('resume-provider')
  expect(fallback?.agentOptions.model).toBe('resume-model')
  expect(resolve).toHaveBeenCalledExactlyOnceWith(undefined)
  expect(mount).toHaveBeenNthCalledWith(1, expect.any(Context), 'stored-preset')
  expect(mount).toHaveBeenNthCalledWith(2, expect.any(Context), 'default-preset')
  expect(attachSession).toHaveBeenNthCalledWith(1, sessionId)
  expect(attachSession).toHaveBeenNthCalledWith(2, legacySessionId)
})

it('clears and releases a current session when the default project changes', async () => {
  let updateCalls = 0
  let pendingPoll: import('node:http').ServerResponse | undefined
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'project-cursor-1',
        msgs: [{
          message_id: 80,
          from_user_id: 'owner-id',
          item_list: [{ type: 1, text_item: { text: 'first project message' } }],
        }],
      })
      else pendingPoll = response
    } else respond(response, { ret: 0 })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-project-switch-'))
  const store = new WechatStore(home)
  const firstProject = join(store.directory, 'project')
  const secondProject = join(home, 'second-project')
  await mkdir(secondProject, { recursive: true })
  await seedCredentials(store, firstProject)
  const projects = [
    { id: 'project-one', title: '第一项目', path: firstProject },
    { id: 'project-two', title: '第二项目', path: secondProject },
  ]
  const workspaceRegistry = {
    resolveByPath: async (path: string) => projects.find(project => project.path === path),
    create: async (path: string, title: string) => ({ id: 'created', path, title }),
    list: () => projects,
  }
  const agents = createFakeAgents(() => {}, async (_agent, _message, events) => {
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply' }] } } })
  })
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    agents: agents.service,
    workspaceRegistry,
  })
  onTestFinished(async () => {
    await harness.ctx.fiber.dispose()
    await agents.dispose()
    await fake.close()
    await rm(home, { recursive: true, force: true })
  })

  await vi.waitFor(() => { expect(sentTexts(fake.requests)).toContain('reply') })
  const previous = (await store.readState()).currentSessionId
  expect(previous).toBeDefined()
  await harness.service.setDefaultProject(secondProject)
  expect(agents.handleDisposals).toBe(1)
  expect(await store.readState()).toMatchObject({ defaultProjectPath: secondProject })
  expect(await store.readState()).not.toHaveProperty('currentSessionId')
  await vi.waitFor(() => { expect(pendingPoll).toBeDefined() })
  const poll = pendingPoll
  if (poll === undefined) throw new Error('the fake iLink server has no pending update poll')
  pendingPoll = undefined
  respond(poll, {
    ret: 0,
    get_updates_buf: 'project-cursor-2',
    msgs: [{
      message_id: 81,
      from_user_id: 'owner-id',
      item_list: [{ type: 1, text_item: { text: 'second project message' } }],
    }],
  })
  await vi.waitFor(() => { expect(agents.createdProjectPaths).toEqual([firstProject, secondProject]) })
  expect((await store.readState()).currentSessionId).not.toBe(previous)
})

it('loads persisted state only once across logout and later status reads', async () => {
  class CountingStore extends WechatStore {
    stateReads = 0

    override async readState() {
      this.stateReads += 1
      return super.readState()
    }
  }
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) return
    else respond(response, { ret: 0 })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-load-once-'))
  const store = new CountingStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  const harness = await fixture(fake.url, store, { sleep: async () => {} })
  onTestFinished(async () => {
    await harness.ctx.fiber.dispose()
    await fake.close()
    await rm(home, { recursive: true, force: true })
  })

  await harness.service.getStatus()
  expect(store.stateReads).toBe(1)
  await harness.service.logout()
  await harness.service.getStatus()
  expect(store.stateReads).toBe(1)
})

it('sends generated tool-media artifacts from structured result metadata', async () => {
  const image = Buffer.from('generated image')
  const relativeArtifact = Buffer.from('relative generated image')
  const relativeArtifactPath = 'generated/relative.png'
  let fileTool: FakeFileTool | undefined
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'generated-media-cursor',
        msgs: [{
          message_id: 90,
          from_user_id: 'owner-id',
          item_list: [{ type: 1, text_item: { text: 'generate an image' } }],
        }],
      })
    } else respond(response, { ret: 0 })
  })
  const cleanup: {
    home?: string
    dispose?: () => Promise<void>
    disposeAgents?: () => Promise<void>
  } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await cleanup.disposeAgents?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-generated-media-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  const artifactDirectory = join(home, 'media-output')
  const artifactPath = join(artifactDirectory, 'image.png')
  await seedCredentials(store, projectPath)
  await mkdir(artifactDirectory, { recursive: true })
  await mkdir(join(projectPath, 'generated'), { recursive: true })
  await writeFile(artifactPath, image)
  await writeFile(join(projectPath, relativeArtifactPath), relativeArtifact)
  const sentMedia: Array<{ readonly kind: string; readonly filename: string; readonly bytes: Uint8Array }> = []
  const agents = createFakeAgents((tool) => { fileTool = tool }, async (_agent, _message, events) => {
    events.push(
      { type: 'tool/call', data: { callId: 'image-call', name: 'generate_image' } },
      {
        type: 'tool/result',
        data: {
          message: { toolCallId: 'image-call', content: [{ type: 'text', text: `Wrote ${artifactPath}.` }] },
          meta: { status: 'done', model: 'image-model', path: artifactPath, nodeId: 'image-node' },
        },
      },
      { type: 'tool/call', data: { callId: 'relative-image-call', name: 'generate_image' } },
      {
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'relative-image-call',
            content: [{ type: 'text', text: `Wrote ${relativeArtifactPath}.` }],
          },
          meta: { status: 'done', model: 'image-model', path: relativeArtifactPath, nodeId: 'relative-image-node' },
        },
      },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done' }] } } },
    )
  })
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    agents: agents.service,
    createClient: (_baseUrl, token) => {
      const client = new IlinkClient(fake.url, token)
      vi.spyOn(client, 'sendMedia').mockImplementation(async (kind, filename, bytes) => {
        sentMedia.push({ kind, filename, bytes })
        return { upload: { ret: 0 }, send: { ret: 0 } }
      })
      return client
    },
  })
  cleanup.dispose = () => harness.ctx.fiber.dispose()
  cleanup.disposeAgents = () => agents.dispose()

  await vi.waitFor(() => { expect(sentMedia).toHaveLength(2) })
  expect(sentMedia[0]).toMatchObject({ kind: 'image', filename: 'image.png' })
  expect(sentMedia[0]?.bytes).toEqual(image)
  expect(sentMedia[1]).toMatchObject({ kind: 'image', filename: 'relative.png' })
  expect(sentMedia[1]?.bytes).toEqual(relativeArtifact)
  await expect(fileTool!.execute({ path: artifactPath }))
    .rejects.toThrow('微信文件只能从当前项目工作区发送')
})

it('isolates generated artifact delivery failures and continues with later files', async () => {
  const failedArtifact = Buffer.from('failed image')
  const nextArtifact = Buffer.from('next image')
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'generated-media-failure-cursor',
        msgs: [
          {
            message_id: 92,
            from_user_id: 'owner-id',
            item_list: [{ type: 1, text_item: { text: 'generate two images' } }],
          },
          {
            message_id: 93,
            from_user_id: 'owner-id',
            item_list: [{ type: 1, text_item: { text: 'continue after media failure' } }],
          },
        ],
      })
    } else respond(response, { ret: 0 })
  })
  const cleanup: {
    home?: string
    dispose?: () => Promise<void>
    disposeAgents?: () => Promise<void>
  } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await cleanup.disposeAgents?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-generated-media-failure-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  const artifactDirectory = join(home, 'media-output')
  const failedPath = join(artifactDirectory, 'failed.png')
  const nextPath = join(artifactDirectory, 'next.png')
  await seedCredentials(store, projectPath)
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(failedPath, failedArtifact)
  await writeFile(nextPath, nextArtifact)
  const mediaAttempts: string[] = []
  const agents = createFakeAgents(() => {}, async (_agent, message, events) => {
    if (userText(message) === 'generate two images') {
      events.push(
        { type: 'tool/call', data: { callId: 'failed-image-call', name: 'generate_image' } },
        {
          type: 'tool/result',
          data: {
            message: { toolCallId: 'failed-image-call', content: [{ type: 'text', text: `Wrote ${failedPath}.` }] },
            meta: { status: 'done', model: 'image-model', path: failedPath, nodeId: 'failed-image-node' },
          },
        },
        { type: 'tool/call', data: { callId: 'next-image-call', name: 'generate_image' } },
        {
          type: 'tool/result',
          data: {
            message: { toolCallId: 'next-image-call', content: [{ type: 'text', text: `Wrote ${nextPath}.` }] },
            meta: { status: 'done', model: 'image-model', path: nextPath, nodeId: 'next-image-node' },
          },
        },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'First turn completed' }] } } },
      )
    } else {
      events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Follow-up processed' }] } } })
    }
  })
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    agents: agents.service,
    createClient: (_baseUrl, token) => {
      const client = new IlinkClient(fake.url, token)
      vi.spyOn(client, 'sendMedia').mockImplementation(async (_kind, filename) => {
        mediaAttempts.push(filename)
        if (filename === 'failed.png') throw new Error('upload failed')
        return { upload: { ret: 0 }, send: { ret: 0 } }
      })
      return client
    },
  })
  cleanup.dispose = () => harness.ctx.fiber.dispose()
  cleanup.disposeAgents = () => agents.dispose()

  await vi.waitFor(() => {
    expect(sentTexts(fake.requests)).toContain('Follow-up processed')
  })
  expect(mediaAttempts).toEqual(['failed.png', 'failed.png', 'next.png'])
  expect(sentTexts(fake.requests)).toContain(`生成的文件没能发到微信，已保存在电脑上：${failedPath}`)
  expect(sentTexts(fake.requests)).not.toContain('微信消息处理失败，请稍后重试')
})

it('compresses oversized videos in a temporary directory and removes the output after sending', async () => {
  const video = Buffer.alloc(20 * 1024 * 1024 + 1)
  let updateCalls = 0
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) respond(response, {
        ret: 0,
        get_updates_buf: 'compress-cursor',
        msgs: [{
          message_id: 91,
          from_user_id: 'owner-id',
          item_list: [{ type: 1, text_item: { text: '/new' } }],
        }],
      })
    } else respond(response, { ret: 0 })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-video-compress-'))
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  await seedCredentials(store, projectPath)
  const videoPath = join(projectPath, 'large.mp4')
  await mkdir(projectPath, { recursive: true })
  await writeFile(videoPath, video)
  let fileTool: FakeFileTool | undefined
  let ffmpegArguments: readonly string[] | undefined
  let compressedPath: string | undefined
  const sentKinds: string[] = []
  const agents = createFakeAgents((tool) => { fileTool = tool })
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    agents: agents.service,
    runFfmpeg: async (arguments_) => {
      ffmpegArguments = arguments_
      compressedPath = arguments_.at(-1)
      if (compressedPath === undefined) throw new Error('ffmpeg output path is missing')
      await writeFile(compressedPath, Buffer.from('compressed video'))
    },
    createClient: (_baseUrl, token) => {
      const client = new IlinkClient(fake.url, token)
      vi.spyOn(client, 'sendMedia').mockImplementation(async (kind) => {
        sentKinds.push(kind)
        return { upload: { ret: 0 }, send: { ret: 0 } }
      })
      return client
    },
  })
  onTestFinished(async () => {
    await harness.ctx.fiber.dispose()
    await agents.dispose()
    await fake.close()
    await rm(home, { recursive: true, force: true })
  })

  await vi.waitFor(() => { expect(fileTool).toBeDefined() })
  await fileTool!.execute({ path: videoPath })
  expect(ffmpegArguments).toContain('-vf')
  expect(ffmpegArguments).toContain('scale=-2:min(720,ih)')
  expect(compressedPath).toBeDefined()
  expect(compressedPath?.startsWith(projectPath)).toBe(false)
  expect(sentKinds).toEqual(['video'])
  if (compressedPath === undefined) throw new Error('ffmpeg output path was not captured')
  await expect(readFile(compressedPath)).rejects.toMatchObject({ code: 'ENOENT' })
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
] as const)('forwards WeChat approval decision %s during the active WeChat turn', async (decision, expected) => {
  const harness = await activeApprovalFixture(decision)
  await expect(harness.result).resolves.toBe(expected)
  expect(sentTexts(harness.fake.requests)).toContain('需要你确认：Update the project file\n回复「同意」或「拒绝」')
})

it('does not forward a desktop-driven approval for a recent WeChat session', async () => {
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) return
    else respond(response, { ret: 0 })
  })
  const cleanup: { home?: string; dispose?: () => Promise<void> } = {}
  onTestFinished(async () => {
    await cleanup.dispose?.()
    await fake.close()
    if (cleanup.home !== undefined) await rm(cleanup.home, { recursive: true, force: true })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-desktop-approval-'))
  cleanup.home = home
  const store = new WechatStore(home)
  const projectPath = join(store.directory, 'project')
  await seedCredentials(store, projectPath)
  const sessionId = SessionId('desktop-approval-session')
  await store.writeState({
    defaultProjectPath: projectPath,
    currentSessionId: sessionId,
    recentSessions: [{ sessionId, title: '微信 · Existing', projectPath, updatedAt: 1 }],
    processedMessageIds: [],
  })
  const harness = await fixture(fake.url, store, { sleep: async () => {} })
  cleanup.dispose = () => harness.ctx.fiber.dispose()
  const request: ApprovalRequest = {
    agent: { session: { id: sessionId } } as never,
    toolName: 'write_file',
    reason: 'Update the project file',
  }

  await expect(harness.serviceContext.waterfall(
    'approval/request',
    request,
    async (): Promise<ApprovalOutcome> => 'allowed-once',
  )).resolves.toBe('allowed-once')
  expect(sentTexts(fake.requests)).not.toContain('需要你确认：Update the project file\n回复「同意」或「拒绝」')
})

it('ends a pending WeChat approval immediately when the Agent is cancelled', async () => {
  const harness = await activeApprovalFixture('/cancel')
  await expect(harness.result).resolves.toBe('rejected')
  expect(sentTexts(harness.fake.requests)).not.toContain('审批已超时，按拒绝处理')
})

it('rejects an active WeChat approval after the five-minute deadline', async () => {
  const scheduled: Array<() => void> = []
  const harness = await activeApprovalFixture(undefined, (callback, milliseconds) => {
    expect(milliseconds).toBe(5 * 60_000)
    scheduled.push(callback)
    return setTimeout(() => {}, milliseconds)
  })
  await vi.waitFor(() => {
    expect(sentTexts(harness.fake.requests)).toContain('需要你确认：Update the project file\n回复「同意」或「拒绝」')
  })
  scheduled[0]?.()
  await expect(harness.result).resolves.toBe('rejected')
  expect(sentTexts(harness.fake.requests)).toContain('审批已超时，按拒绝处理')
})

async function fixture(
  baseUrl: string,
  store: WechatStore,
  dependencies: {
    readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
    readonly schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>
    readonly agents?: object
    readonly agentDefaultModel?: object
    readonly agentPresets?: object
    readonly canvas?: boolean
    readonly createClient?: (baseUrl: string, token?: string) => IlinkClient
    readonly workspaceRegistry?: object
    readonly sessionTitle?: object
    readonly runFfmpeg?: (arguments_: readonly string[]) => Promise<void>
  },
  onStatus?: (status: WechatStatus) => void,
) {
  const ctx = new Context()
  const unlisten = onStatus === undefined ? () => {} : ctx.on('wechat/status', onStatus)
  const {
    agents, agentDefaultModel, agentPresets, canvas = true, createClient, workspaceRegistry, sessionTitle,
    ...serviceDependencies
  } = dependencies
  ctx.provide('agents', (agents ?? { get: () => undefined, create: async () => { throw new Error('unexpected agent creation') } }) as never)
  ctx.provide('agentDefaultModel', agentDefaultModel ?? {
    currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }),
  } as never)
  ctx.provide('workspaceRegistry', workspaceRegistry ?? {
    resolveByPath: async (path: string) => ({ id: 'wechat-project', path, title: '微信', attachSession: async () => {} }),
    create: async (path: string, title: string) => ({
      id: 'wechat-project', path, title, attachSession: async () => {},
    }),
    list: () => [{ id: 'wechat-project', path: join(store.directory, 'project'), title: '微信' }],
  } as never)
  if (sessionTitle !== undefined) ctx.provide('sessionTitle', sessionTitle as never)
  if (agentPresets !== undefined) ctx.provide('agentPresets', agentPresets as never)
  ctx.provide('permissionPresets', { set: async () => {} } as never)
  if (canvas) ctx.provide('canvas', { edit: async () => {} } as never)
  let service!: WechatService
  let serviceContext!: Context
  const plugin = ctx.plugin({
    inject: injectedServices,
    apply: (scope) => {
      serviceContext = scope
      service = new WechatService(scope, {
        store,
        createClient: createClient ?? ((_url, token) => new IlinkClient(baseUrl, token)),
        ...serviceDependencies,
      })
    },
  })
  await plugin
  return { ctx, service, serviceContext, unlisten }
}

async function activeApprovalFixture(
  decision?: string,
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>,
) {
  let updateCalls = 0
  let pendingPoll: import('node:http').ServerResponse | undefined
  let pendingDecision: string | undefined
  let decisionDelivered = false
  const deliverDecision = (): void => {
    if (decision === undefined || decisionDelivered) return
    const poll = pendingPoll
    if (poll === undefined) {
      pendingDecision = decision
      decisionDelivered = true
      return
    }
    pendingPoll = undefined
    decisionDelivered = true
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
  const fake = await createFakeIlinkServer((request, response) => {
    if (request.path.endsWith('/notifystart') || request.path.endsWith('/notifystop')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getconfig')) respond(response, { ret: 0 })
    else if (request.path.endsWith('/getupdates')) {
      updateCalls += 1
      if (updateCalls === 1) {
        respond(response, {
          ret: 0,
          get_updates_buf: 'initial-cursor',
          msgs: [{
            message_id: 43,
            from_user_id: 'owner-id',
            item_list: [{ type: 1, text_item: { text: 'please proceed' } }],
          }],
        })
      } else if (pendingDecision !== undefined) {
        const value = pendingDecision
        pendingDecision = undefined
        pendingPoll = response
        deliverDecisionFor(response, value)
      } else {
        pendingPoll = response
      }
    } else if (request.path.endsWith('/sendmessage')) {
      respond(response, { ret: 0 })
      deliverDecision()
    } else respond(response, { ret: 0 })
  })
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-active-approval-'))
  const store = new WechatStore(home)
  await seedCredentials(store, join(store.directory, 'project'))
  let resolveServiceContext!: (ctx: Context) => void
  const serviceContext = new Promise<Context>((resolve) => { resolveServiceContext = resolve })
  let resolveResult!: (outcome: ApprovalOutcome) => void
  const result = new Promise<ApprovalOutcome>((resolveResultPromise) => { resolveResult = resolveResultPromise })
  const agents = createFakeAgents(() => {}, async (agent) => {
    const signal = agent.signal
    const approval = (await serviceContext).waterfall('approval/request', {
      agent: agent as never,
      toolName: 'write_file',
      reason: 'Update the project file',
      ...(signal === undefined ? {} : { signal }),
    }, async (): Promise<ApprovalOutcome> => 'unavailable')
    resolveResult(await approval)
  })
  const harness = await fixture(fake.url, store, {
    sleep: async () => {},
    agents: agents.service,
    ...(schedule === undefined ? {} : { schedule }),
  })
  resolveServiceContext(harness.serviceContext)
  onTestFinished(async () => {
    await harness.ctx.fiber.dispose()
    await agents.dispose()
    await fake.close()
    await rm(home, { recursive: true, force: true })
  })
  return { fake, result }
}

function deliverDecisionFor(response: import('node:http').ServerResponse, decision: string): void {
  respond(response, {
    ret: 0,
    get_updates_buf: 'approval-cursor',
    msgs: [{
      message_id: 44,
      from_user_id: 'owner-id',
      item_list: [{ type: 1, text_item: { text: decision } }],
    }],
  })
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
  readonly signal: AbortSignal | undefined
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
  readonly agentOptions: AgentOptions
  readonly meta: { readonly cwd: string; readonly agentPreset?: string }
  readonly setup: (ctx: Context, agent: never) => Promise<void>
}

function createFakeAgents(
  onTool: (tool: FakeFileTool) => void,
  onFollowup?: (agent: FakeAgent, message: unknown, events: unknown[]) => Promise<void>,
): {
  readonly service: object
  readonly toolDisposals: number
  readonly createCalls: number
  readonly handleDisposals: number
  readonly createdProjectPaths: string[]
  readonly createOptions: FakeCreateOptions[]
  readonly createErrors: string[]
  readonly registeredToolNames: string[]
  dispose(): Promise<void>
} {
  const agents = new Map<string, FakeAgent>()
  const contexts: Context[] = []
  let toolDisposals = 0
  let createCalls = 0
  let handleDisposals = 0
  const createErrors: string[] = []
  const registeredToolNames: string[] = []
  const createdProjectPaths: string[] = []
  const createOptions: FakeCreateOptions[] = []
  let disposed = false
  return {
    service: {
      get: (sessionId: string) => agents.get(sessionId),
      create: async (options: FakeCreateOptions) => {
        createCalls += 1
        createOptions.push(options)
        createdProjectPaths.push(options.meta.cwd)
        const events: unknown[] = []
        const agentContext = new Context()
        let activity = Promise.resolve()
        let activeTurn: AbortController | undefined
        const agent: FakeAgent = {
          ctx: agentContext,
          get signal() { return activeTurn?.signal },
          session: {
            id: options.sessionId,
            header: { cwd: options.meta.cwd },
            get seq() { return events.length },
          },
          followup: (message) => {
            const firstNewEvent = events.length
            const controller = new AbortController()
            activeTurn = controller
            activity = Promise.resolve(onFollowup?.(agent, message, events)).then(() => {
              for (let index = firstNewEvent; index < events.length; index += 1) {
                const value = asRecord(events[index])
                if (value === undefined) continue
                const event = { ...value, seq: index, time: Date.now() }
                events[index] = event
                agentContext.emit('session/event', agent.session as never, event as never)
              }
            }).finally(() => {
              if (activeTurn === controller) activeTurn = undefined
            })
          },
          whenIdle: () => activity,
          cancel: () => { activeTurn?.abort() },
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
        return {
          agent,
          dispose: async () => {
            handleDisposals += 1
            agents.delete(String(options.sessionId))
            await agentContext.fiber.dispose()
          },
        }
      },
      resume: async () => { throw new Error('unexpected agent resume') },
    },
    get toolDisposals() { return toolDisposals },
    get createCalls() { return createCalls },
    get handleDisposals() { return handleDisposals },
    createdProjectPaths,
    createOptions,
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
