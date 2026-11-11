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
    expect((await stat(store.credentialsPath)).mode & 0o777).toBe(0o600)
    expect((await stat(store.cursorPath)).mode & 0o777).toBe(0o600)
    expect((await stat(store.statePath)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(store.cursorPath, 'utf8'))).toEqual({ get_updates_buf: 'opaque-cursor-value' })
    expect((await readdir(store.directory)).some(name => name.endsWith('.tmp'))).toBe(false)
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
