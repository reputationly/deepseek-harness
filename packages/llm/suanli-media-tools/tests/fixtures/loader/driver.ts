#!/usr/bin/env node
/**
 * Test driver: start the canned gateway, boot the chat-generation Loader composition, call
 * generate_image and generate_video through the tool registry, and write what the model and the card would see to
 * `./media-tools-report.json` for the package spec's inspect step. A proxy in front of the gateway counts video
 * submissions and can leave status polls unanswered, so a second boot over the same storage stands in for a Host
 * restart while a video renders.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { startFakeGateway } from '@deepseek-ai/dsh-session-snapshot'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('media-tools driver requires a config path')

const gateway = await startFakeGateway()
const origin = gateway.url.replace(/\/v1$/u, '')
let submits = 0
let holdStatus = false
const held = new Set<ServerResponse>()
const body = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
const proxy = createServer((request, response) => {
  void (async () => {
    const url = request.url ?? '/'
    const path = url.split('?')[0] ?? url
    if (request.method === 'POST' && path === '/v1/videos') submits += 1
    if (holdStatus && request.method === 'GET' && /^\/v1\/videos\/[^/]+$/u.test(path)) {
      held.add(response)
      return
    }
    const payload = await body(request)
    const upstream = await fetch(`${origin}${url}`, {
      method: request.method ?? 'GET',
      headers: { 'content-type': request.headers['content-type'] ?? 'application/json' },
      ...request.method === 'GET' || request.method === 'HEAD' ? {} : { body: payload },
    })
    response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
    response.end(Buffer.from(await upstream.arrayBuffer()))
  })()
})
await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
process.env.SUANLI_FIXTURE_GATEWAY = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}/v1`
process.env.SUANLI_FIXTURE_KEY = 'sk-fixture'
process.env.SUANLI_FIXTURE_STORAGE = await mkdtemp(join(tmpdir(), 'suanli-media-tools-storage-'))

const start = async () => await boot('suanli-media-tools-loader-smoke', resolveConfigPath(configPath, undefined), undefined, (host) => {
  host.provide('settings', { describe: () => [], mutate: async () => {} } as never)
})
const until = async (done: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!done() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
}
let ctx = await start()
const asked: unknown[] = []
ctx.on('user-questions/request', async (request) => {
  asked.push(request.questions.map(question => ({ id: question.id, options: (question.options ?? []).map(option => option.label) })))
  return { answers: request.questions.map(question => ({ id: question.id, selected: [question.options?.[0]?.label ?? ''] })) }
})
try {
  const deadline = Date.now() + 10_000
  while (ctx.tools.get('generate_image') === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  const schema = ctx.tools.schemas().find(tool => tool.name === 'generate_image')
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('loader-image'),
    name: 'generate_image',
    arguments: { prompt: 'a kitten playing' },
  })
  while (ctx.tools.get('generate_video') === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  const askedBeforeVideo = asked.length
  const video = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('loader-video'),
    name: 'generate_video',
    arguments: { prompt: 'a sunset over the sea', aspect_ratio: '竖屏', resolution: '768P', duration_seconds: 5 },
  })
  const restartArgs = { prompt: 'a lighthouse at night', aspect_ratio: '竖屏', resolution: '768P', duration_seconds: 5 }
  const submitsBeforeRestart = submits
  holdStatus = true
  void executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('loader-video-interrupted'),
    name: 'generate_video',
    arguments: restartArgs,
  }).catch(() => undefined)
  await until(() => held.size > 0)
  const submittedBeforeRestart = submits - submitsBeforeRestart
  await ctx.fiber.dispose()
  holdStatus = false
  ctx = await start()
  await until(() => ctx.tools.get('generate_video') !== undefined)
  const resumed = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('loader-video-resumed'),
    name: 'generate_video',
    arguments: restartArgs,
  })
  await writeFile('./media-tools-report.json', JSON.stringify({
    restart: {
      submittedBeforeRestart,
      submittedAfterRestart: submits - submitsBeforeRestart - submittedBeforeRestart,
      isError: resumed.isError,
      meta: resumed.meta,
    },
    video: { isError: video.isError, meta: video.meta, asked: asked.length - askedBeforeVideo },
    schemaProperties: Object.keys(schema?.parameters.properties ?? {}),
    isError: result.isError,
    text: result.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    meta: result.meta,
    generated: await readdir('./generated').catch(() => []),
    asked,
  }))
} finally {
  await ctx.fiber.dispose()
  for (const response of held) response.destroy()
  proxy.closeAllConnections()
  await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
  await gateway.close()
}
