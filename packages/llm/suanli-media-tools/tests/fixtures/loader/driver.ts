#!/usr/bin/env node
/**
 * Test driver: start the canned gateway, boot the chat-generation Loader composition, call
 * generate_image and generate_video through the tool registry, and write what the model and the card would see to
 * `./media-tools-report.json` for the package spec's inspect step.
 */
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
process.env.SUANLI_FIXTURE_GATEWAY = gateway.url
process.env.SUANLI_FIXTURE_KEY = 'sk-fixture'
process.env.SUANLI_FIXTURE_STORAGE = await mkdtemp(join(tmpdir(), 'suanli-media-tools-storage-'))

const ctx = await boot('suanli-media-tools-loader-smoke', resolveConfigPath(configPath, undefined), undefined, (host) => {
  host.provide('settings', { describe: () => [], mutate: async () => {} } as never)
})
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
  await writeFile('./media-tools-report.json', JSON.stringify({
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
  await gateway.close()
}
