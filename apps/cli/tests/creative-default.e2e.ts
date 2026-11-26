/** The 创作 workbench the Web template selects, through the shipped Web Loader and live plugin manager. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const installAnchor = join(root, 'apps/cli/package.json')
const name = '@q253595422/dsh-imagegen-video'

describe.skipIf(!existsSync(join(root, 'apps/cli/lib/bin.js')))('Default 创作 workbench', { retry: 0 }, () => {
  let ctx: Context
  let temporary: string
  let originalEnvironment: Record<string, string | undefined> = {}

  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-creative-'))
    const workspace = join(temporary, 'workspace')
    await mkdir(workspace)
    const home = join(temporary, 'home')
    const values = {
      DSH_HOME: home, DSH_AGENTS_HOME: join(temporary, 'agents'), DSH_BUNDLED_SKILL_DIR: join(temporary, 'skills'),
      DSH_TELEMETRY_DISABLED: '1', TMUX: '', TMUX_PANE: '',
    }
    originalEnvironment = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
    Object.assign(process.env, values)
    const require = createRequire(import.meta.url)
    const app = require(join(root, 'packages/boot/app-boot/lib/index.js')) as typeof import('@deepseek-ai/dsh-app-boot')
    const cmdline = require(join(root, 'packages/boot/cmdline/lib/index.js')) as typeof import('@deepseek-ai/dsh-cmdline')
    const bundles = require(join(root, 'packages/util/official-bundles/lib/index.js')) as typeof import('@deepseek-ai/dsh-official-bundles')
    const directory = join(home, 'profiles', 'web')
    app.initProfile(directory, bundles.PROFILE_TEMPLATES.web!.bundles)
    await writeFile(join(directory, 'cordis.yml'), '[]\n')
    const profile = app.loadProfileDirectory('creative-test', directory, installAnchor)
    const profileContext: ProfileContext = {
      name: 'web', dir: directory, patchPath: profile.patchPath, installAnchor, cwd: workspace, home,
      startedBundles: profile.layers.map(layer => layer.packageName), overlays: [], telemetryDisabledEnv: '1',
    }
    const resolution = await app.createRuntimeResolution({ installAnchor, home, profile })
    const listeners = new Set<() => void>()
    let ready = false
    ctx = await app.boot('creative-test', join(directory, 'cordis.yml'), app.readProfilePatches('creative-test', profileContext), async (owner) => {
      owner.provide('profileContext', profileContext)
      owner.provide('appReady', { onReady: (listener) => {
        if (ready) { listener(); return () => {} }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      } })
      await owner.plugin(app.PluginPackages, { resolution })
      cmdline.provideCmdline(owner, { args: ['--no-open', '--port', '0'], exit: (code) => { throw new Error(`Web command exited ${String(code)}`) } })
    })
    ready = true
    for (const listener of listeners) listener()
    listeners.clear()
  }, 120_000)

  afterAll(async () => {
    try {
      await ctx?.fiber.dispose()
    } finally {
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      if (temporary !== undefined) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 120_000)

  /** Ask the catalog route as a signed-in browser and an anonymous one; a missing route falls through to the Web client. */
  async function catalog(): Promise<{ signedIn: string; anonymous: number }> {
    await expect.poll(() => ctx.webServer.port, { timeout: 30_000 }).toBeDefined()
    const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
    const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
    await login.body?.cancel()
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    expect(cookie).not.toBe('')
    const url = `${origin}/api/dsh-imagegen/gateway/catalog`
    const signedIn = await fetch(url, { headers: { cookie } })
    const anonymous = await fetch(url)
    await anonymous.body?.cancel()
    return { signedIn: `${String(signedIn.status)} ${String(signedIn.headers.get('content-type'))} ${await signedIn.text()}`.slice(0, 300), anonymous: anonymous.status }
  }

  it('starts switched on and reports a profile without a gateway as not configured', async () => {
    const bundle = (await ctx.pluginManager.listBundles()).find(entry => entry.name === name)
    expect(bundle).toMatchObject({ availability: 'installation', optional: true, enabled: true, removable: false })
    expect(bundle?.rows.length).toBeGreaterThan(0)
    for (const row of bundle?.rows ?? []) expect(row.entryId).toBeDefined()
    const answer = await catalog()
    expect(answer.signedIn).toMatch(/^200 application\/json/)
    expect(answer.signedIn).toContain('"status":"not-configured"')
  })

  it('switches off and on again from the plugin manager', async () => {
    expect(await ctx.pluginManager.setBundleEnabled(name, false)).toMatchObject({ changed: true, application: 'applied' })
    expect((await catalog()).signedIn).not.toMatch(/application\/json/)
    expect(await ctx.pluginManager.setBundleEnabled(name, true)).toMatchObject({ changed: true, application: 'applied' })
    expect((await catalog()).signedIn).toMatch(/^200 application\/json/)
  })
})
