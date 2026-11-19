/** Manual installer handoff: streamed verification, platform-specific replacement, and open failures. */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createManualInstall, readFeedDirectory, selectInstallerAsset, type ManualInstallOptions,
} from '../src/update-manual-install.ts'

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

function responseFromChunks(chunks: readonly Uint8Array[], headers?: HeadersInit): Response {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      if (chunk === undefined) controller.close()
      else {
        index++
        controller.enqueue(chunk)
      }
    },
  }), headers === undefined ? undefined : { headers })
}

function indexFor(
  overrides: {
    name?: string
    url?: string
    size?: number | undefined
    sha256?: string | undefined
  } = {},
  version = '1.1.0-rc.2',
) {
  return {
    version,
    files: [
      { name: 'app-1.1.0-rc.2-mac-arm64.zip', url: `${FEED}/versions/1.1.0-rc.2/app.zip`, size: 1 },
      { name: 'app-1.1.0-rc.2-mac-arm64.dmg', url: `${FEED}/versions/1.1.0-rc.2/app.dmg`, size: bytes.byteLength, sha256: digest, ...overrides },
      { name: 'app-1.1.0-rc.2-win-x64.exe', url: `${FEED}/versions/1.1.0-rc.2/app.exe`, size: 2 },
    ],
  }
}

function manualPort(directory: string, send: typeof fetch, openPath: (path: string) => Promise<string> = async () => '') {
  return createManualInstall({ directory, feedDirectory: FEED, platform: 'darwin', send, openPath, quit: () => {} })
}

async function expectDownloadFilesMissing(directory: string) {
  const target = `${directory}/app-1.1.0-rc.2-mac-arm64.dmg`
  await expect(readFile(target)).rejects.toThrow()
  await expect(readFile(`${target}.download`)).rejects.toThrow()
}

function expectedProgress() {
  const delivered = [4, 8, 12, bytes.byteLength]
  return delivered.map(count => Math.min(99, Math.floor(count / bytes.byteLength * 100))).concat(100)
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
    const chunks = [bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8, 12), bytes.subarray(12)]
    const { send, calls } = transport(indexFor(), () => responseFromChunks(chunks))
    const port = manualPort(directory, send)
    const percent: number[] = []
    const path = await port.prepare('1.1.0-rc.2', (value) => { percent.push(value) })
    expect(path).toBe(`${directory}/app-1.1.0-rc.2-mac-arm64.dmg`)
    expect(percent).toEqual(expectedProgress())
    expect(percent.slice(0, -1).every(value => value < 100)).toBe(true)
    expect(calls[0]).toBe(`${FEED}/latest.json`)
    expect([...await readFile(path)]).toEqual([...bytes])
  })

  it('uses content-length for progress when the index omits size', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const chunks = [bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8, 12), bytes.subarray(12)]
    const { send } = transport(indexFor({ size: undefined }), () => responseFromChunks(chunks, { 'content-length': String(bytes.byteLength) }))
    const port = manualPort(directory, send)
    const percent: number[] = []
    await port.prepare('1.1.0-rc.2', (value) => { percent.push(value) })
    expect(percent).toEqual(expectedProgress())
  })

  it('reports no intermediate progress when neither size nor content-length is available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor({ size: undefined, sha256: undefined }), () => responseFromChunks([bytes]))
    const port = manualPort(directory, send)
    const percent: number[] = []
    await port.prepare('1.1.0-rc.2', (value) => { percent.push(value) })
    expect(percent).toEqual([100])
  })

  it('rejects a version the feed no longer offers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor())
    const port = manualPort(directory, send)
    await expect(port.prepare('1.1.0-rc.1', () => {})).rejects.toThrow(/the feed offers 1.1.0-rc.2/u)
  })

  it('rejects a download whose size differs from the index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor({ size: bytes.byteLength + 1 }))
    const port = manualPort(directory, send)
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/bytes, the feed published/u)
    await expectDownloadFilesMissing(directory)
  })

  it('rejects a download whose digest differs from the index', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor({ sha256: 'nope' }))
    const port = manualPort(directory, send)
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/SHA-256/u)
    await expectDownloadFilesMissing(directory)
  })

  it('reports a refused artifact download', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor(), () => new Response(null, { status: 403 }))
    const port = manualPort(directory, send)
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/HTTP 403/u)
    await expectDownloadFilesMissing(directory)
  })

  it('rejects an artifact response without a body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor(), () => new Response(null))
    const port = manualPort(directory, send)
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/installer download failed/u)
    await expectDownloadFilesMissing(directory)
  })

  it('removes partial files when the artifact stream fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const failedResponse = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 4))
        controller.error(new Error('connection interrupted'))
      },
    }))
    const { send } = transport(indexFor(), failedResponse)
    const port = manualPort(directory, send)
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/connection interrupted/u)
    await expectDownloadFilesMissing(directory)
  })

  it('deletes the artifact when the shell cannot open it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor())
    const port = manualPort(directory, send, async () => 'no handler')
    const path = await port.prepare('1.1.0-rc.2', () => {})
    await writeFile(path, bytes)
    await expect(port.open(path)).rejects.toThrow(/could not be opened: no handler/u)
    await expect(readFile(path)).rejects.toThrow()
  })

  it('starts a detached Windows installer and quits only after it spawns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const unref = vi.fn()
    const child = Object.assign(new EventEmitter(), { unref })
    const start = vi.fn<NonNullable<ManualInstallOptions['spawn']>>(() => child)
    const quit = vi.fn()
    const port = createManualInstall({
      directory, feedDirectory: FEED, platform: 'win32', openPath: async () => '', spawn: start, quit,
    })

    expect(port.replacesInPlace).toBe(true)
    const replacing = port.replace('C:/downloads/update.exe')
    expect(start).toHaveBeenCalledWith('C:/downloads/update.exe', ['/S', '--updated', '--force-run'], {
      detached: true, stdio: 'ignore', windowsHide: false,
    })
    expect(unref).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    child.emit('spawn')
    await expect(replacing).resolves.toBeUndefined()
    expect(unref).toHaveBeenCalledOnce()
    expect(quit).toHaveBeenCalledOnce()
  })

  it('rejects a Windows installer spawn error without quitting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const unref = vi.fn()
    const child = Object.assign(new EventEmitter(), { unref })
    const start = vi.fn<NonNullable<ManualInstallOptions['spawn']>>(() => child)
    const quit = vi.fn()
    const port = createManualInstall({
      directory, feedDirectory: FEED, platform: 'win32', openPath: async () => '', spawn: start, quit,
    })
    const replacing = port.replace('C:/downloads/update.exe')
    child.emit('error', new Error('spawn failed'))
    await expect(replacing).rejects.toThrow('spawn failed')
    expect(quit).not.toHaveBeenCalled()
  })

  it('does not replace in place on macOS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const port = createManualInstall({
      directory, feedDirectory: FEED, platform: 'darwin', openPath: async () => '', quit: () => {},
    })
    expect(port.replacesInPlace).toBe(false)
    await expect(port.replace('/downloads/update.dmg')).rejects.toThrow(/only supported on Windows/u)
  })
})
