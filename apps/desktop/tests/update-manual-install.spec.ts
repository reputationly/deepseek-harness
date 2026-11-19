/** Manual installer handoff: index-driven artifact selection, verified download, and open failures. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createManualInstall, readFeedDirectory, selectInstallerAsset } from '../src/update-manual-install.ts'

const created: string[] = []
afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

const bytes = Buffer.from('installer-bytes')
const digest = createHash('sha256').update(bytes).digest('hex')
const FEED = 'https://cdn.example/suanli-assistant/darwin-arm64'

/** One responder that answers latest.json and the artifact it names. */
function transport(index: unknown, artifact: () => Response = () => new Response(bytes)) {
  const calls: string[] = []
  const send = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    return url.endsWith('/latest.json') ? new Response(JSON.stringify(index)) : artifact()
  })
  return { send, calls }
}

function indexFor(overrides: Partial<{ name: string; url: string; size: number; sha256: string }> = {}, version = '1.1.0-rc.2') {
  return {
    version,
    files: [
      { name: 'app-1.1.0-rc.2-mac-arm64.zip', url: `${FEED}/versions/1.1.0-rc.2/app.zip`, size: 1 },
      { name: 'app-1.1.0-rc.2-mac-arm64.dmg', url: `${FEED}/versions/1.1.0-rc.2/app.dmg`, size: bytes.byteLength, sha256: digest, ...overrides },
      { name: 'app-1.1.0-rc.2-win-x64.exe', url: `${FEED}/versions/1.1.0-rc.2/app.exe`, size: 2 },
    ],
  }
}

describe('selectInstallerAsset', () => {
  const files = [
    { name: 'app-1.0.0-mac-arm64.zip', url: 'https://cdn/zip' },
    { name: 'app-1.0.0-mac-arm64.dmg', url: 'https://cdn/dmg' },
    { name: 'app-1.0.0-win-x64.exe', url: 'https://cdn/exe' },
  ]

  it('picks the installer a platform runs by hand', () => {
    expect(selectInstallerAsset(files, 'darwin')?.url).toBe('https://cdn/dmg')
    expect(selectInstallerAsset(files, 'win32')?.url).toBe('https://cdn/exe')
  })

  it('reports no installer for other platforms or an index without one', () => {
    expect(selectInstallerAsset(files, 'linux')).toBeUndefined()
    expect(selectInstallerAsset([files[0]!], 'darwin')).toBeUndefined()
  })
})

describe('readFeedDirectory', () => {
  it('reads the feed directory the packaged manifest carries', async () => {
    await expect(readFeedDirectory('/res', async () => `provider: generic\nurl: ${FEED}\nchannel: nightly\n`))
      .resolves.toBe(FEED)
  })

  it('reports no feed when the build carries no update source', async () => {
    await expect(readFeedDirectory('/res', async () => { throw new Error('ENOENT') })).resolves.toBeUndefined()
  })
})

describe('createManualInstall', () => {
  it('downloads the platform installer the index names after verifying it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send, calls } = transport(indexFor())
    const port = createManualInstall({ directory, feedDirectory: FEED, send, openPath: async () => '' })
    const percent: number[] = []
    const path = await port.prepare('1.1.0-rc.2', (value) => { percent.push(value) })
    expect(path).toBe(`${directory}/${process.platform === 'win32'
      ? 'app-1.1.0-rc.2-win-x64.exe' : 'app-1.1.0-rc.2-mac-arm64.dmg'}`)
    expect(percent).toEqual([100])
    expect(calls[0]).toBe(`${FEED}/latest.json`)
    if (process.platform !== 'win32') expect([...await readFile(path)]).toEqual([...bytes])
  })

  it('rejects a version the feed no longer offers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor())
    const port = createManualInstall({ directory, feedDirectory: FEED, send, openPath: async () => '' })
    await expect(port.prepare('1.1.0-rc.1', () => {})).rejects.toThrow(/the feed offers 1.1.0-rc.2/u)
  })

  it('rejects a download whose size differs from the index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor({ size: bytes.byteLength + 1 }))
    const port = createManualInstall({ directory, feedDirectory: FEED, send, openPath: async () => '' })
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/bytes, the feed published/u)
  })

  it('rejects a download whose digest differs from the index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor({ sha256: 'nope' }))
    const port = createManualInstall({ directory, feedDirectory: FEED, send, openPath: async () => '' })
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/SHA-256/u)
  })

  it('reports a refused artifact download', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor(), () => new Response(null, { status: 403 }))
    const port = createManualInstall({ directory, feedDirectory: FEED, send, openPath: async () => '' })
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/HTTP 403/u)
  })

  it('deletes the artifact when the shell cannot open it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor())
    const port = createManualInstall({ directory, feedDirectory: FEED, send, openPath: async () => 'no handler' })
    const path = await port.prepare('1.1.0-rc.2', () => {})
    await writeFile(path, bytes)
    await expect(port.open(path)).rejects.toThrow(/could not be opened: no handler/u)
    await expect(readFile(path)).rejects.toThrow()
  })
})
