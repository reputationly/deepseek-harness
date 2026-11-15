import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WechatStore } from '../src/storage.ts'

describe('WechatStore', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('persists private credentials, raw cursor and a bounded dedupe history atomically', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-store-'))
    roots.push(home)
    const store = new WechatStore(home)
    const credentials = {
      token: 'private-token',
      baseUrl: 'https://ilink.example',
      botId: 'bot-id',
      ownerUserId: 'owner-id',
    }
    await store.writeCredentials(credentials)
    await store.writeCursor('opaque-cursor-value')
    await store.writeState({
      recentSessions: [],
      processedMessageIds: Array.from({ length: 510 }, (_, index) => String(index)),
    })
    expect(await store.readCredentials()).toEqual(credentials)
    expect(await store.readCursor()).toBe('opaque-cursor-value')
    const state = await store.readState()
    expect(state.processedMessageIds).toHaveLength(500)
    expect(state.processedMessageIds[0]).toBe('10')
    expect(JSON.parse(await readFile(store.cursorPath, 'utf8'))).toEqual({ get_updates_buf: 'opaque-cursor-value' })
    expect((await readdir(store.directory)).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('uses owner-only POSIX permissions for stored state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-mode-'))
    roots.push(home)
    const store = new WechatStore(home)
    await store.writeCredentials({ token: 'test', baseUrl: 'https://ilink.example', botId: 'bot', ownerUserId: 'owner' })
    await store.writeCursor('cursor')
    await store.writeState({ recentSessions: [], processedMessageIds: [] })
    for (const path of [store.credentialsPath, store.cursorPath, store.statePath]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it('removes credentials and cursor on logout while retaining binding state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-store-'))
    roots.push(home)
    const store = new WechatStore(home)
    await store.writeCredentials({
      token: 'private-token',
      baseUrl: 'https://ilink.example',
      botId: 'bot-id',
      ownerUserId: 'owner-id',
    })
    await store.writeCursor('cursor')
    await store.writeState({ recentSessions: [], processedMessageIds: [] })
    await store.removeCredentialsAndCursor()
    await expect(store.readCredentials()).resolves.toBeUndefined()
    await expect(store.readCursor()).resolves.toBe('')
    await expect(store.readState()).resolves.toMatchObject({ recentSessions: [], processedMessageIds: [] })
  })
})
