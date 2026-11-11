import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it } from 'vitest'
import WechatService from '@deepseek-ai/dsh-wechat'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('loads the bundle patch through Cordis Loader with its real Host and Client marker plugins', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wechat-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, '[]\n')
  const clientUiModule: unknown = await import(new URL('../../client-ui-wechat/src/index.ts', import.meta.url).href)
  if (!isClientPlugin(clientUiModule)) throw new Error('the Client package has no Cordis plugin entry')
  const patches = loadOverlayPatches('dsh', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-wechat', WechatService],
    ['@deepseek-ai/dsh-client-ui-wechat', clientUiModule],
  ])
  const app = await boot('dsh', configPath, patches, (ctx) => {
    ctx.provide('agents', { get: () => undefined } as never)
    ctx.provide('workspaceRegistry', {
      list: () => [],
      resolveByPath: async () => undefined,
      create: async () => { throw new Error('workspace creation is not part of this loading test') },
    } as never)
    ctx.provide('permissionPresets', { set: async () => {} } as never)
    ctx.provide('canvas', { edit: async () => {} } as never)
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as never
  }, pathToFileURL(process.cwd()).href + '/')
  context = app

  const service = app.get('wechat')
  expect(service).toBeInstanceOf(WechatService)
  if (!(service instanceof WechatService)) throw new Error('the Loader did not mount the WeChat Host service')
  expect((await service.getStatus()).status).toEqual({ state: 'idle' })
  expect([...app.loader.entries()].filter(entry => !entry.disabled).map(entry => entry.options.id))
    .toContain('wechat')
  await app.fiber.dispose()
  context = undefined
  expect(app.get('wechat')).toBeUndefined()
})

function isClientPlugin(value: unknown): value is { apply(): void } {
  return typeof value === 'object' && value !== null && 'apply' in value && typeof value.apply === 'function'
}
