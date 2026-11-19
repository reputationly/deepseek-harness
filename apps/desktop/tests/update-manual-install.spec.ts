/** Manual installer handoff: streamed verification, platform-specific replacement, and open failures. */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearInstallerDirectory, createManualInstall, readFeedDirectory, selectInstallerAsset, type ManualInstallOptions,
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

function interruptedResponse(chunk: Uint8Array, headers?: HeadersInit): Response {
  let sent = false
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) controller.error(new TypeError('terminated'))
      else {
        sent = true
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

function manualPort(directory: string, send: typeof fetch, options: {
  openPath?: (path: string) => Promise<string>
  ownsDirectory?: boolean
  retryDelayMs?: number
} = {}) {
  return createManualInstall({
    directory, feedDirectory: FEED, platform: 'darwin', send,
    openPath: options.openPath ?? (async () => ''), quit: () => {},
    ...(options.ownsDirectory === undefined ? {} : { ownsDirectory: options.ownsDirectory }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  })
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

describe('clearInstallerDirectory', () => {
  it('retries removal failures until a later attempt succeeds', async () => {
    const directory = '/temp/suanli-assistant-update'
    const paths: string[] = []
    const remove = vi.fn(async (path: string) => {
      paths.push(path)
      if (paths.length < 3) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    })

    await expect(clearInstallerDirectory(directory, { attempts: 4, delayMs: 0, remove }))
      .resolves.toBeUndefined()
    expect(paths).toEqual([directory, directory, directory])
  })

  it('rejects with the last error after exhausting attempts', async () => {
    const directory = '/temp/suanli-assistant-update'
    const attempts = 4
    const paths: string[] = []
    const lastError = new Error('last removal failure')
    const remove = vi.fn(async (path: string) => {
      paths.push(path)
      throw paths.length === attempts ? lastError : new Error(`removal failure ${String(paths.length)}`)
    })

    await expect(clearInstallerDirectory(directory, { attempts, delayMs: 0, remove })).rejects.toBe(lastError)
    expect(paths).toEqual(Array.from({ length: attempts }, () => directory))
  })

  it('returns after the first successful removal attempt', async () => {
    const paths: string[] = []
    const remove = vi.fn(async (path: string) => { paths.push(path) })

    await expect(clearInstallerDirectory('/temp/suanli-assistant-update', { attempts: 4, delayMs: 0, remove }))
      .resolves.toBeUndefined()
    expect(paths).toEqual(['/temp/suanli-assistant-update'])
  })

  it('requires at least one attempt', async () => {
    const remove = vi.fn(async () => {})

    await expect(clearInstallerDirectory('/temp/suanli-assistant-update', { attempts: 0, delayMs: 0, remove }))
      .rejects.toThrow('at least one attempt')
    expect(remove).not.toHaveBeenCalled()
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

  it('clears old installers when the updater owns the directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const oldPath = join(directory, 'old-installer.exe')
    await writeFile(oldPath, 'old installer')
    const { send } = transport(indexFor())
    const port = manualPort(directory, send, { ownsDirectory: true })
    const path = await port.prepare('1.1.0-rc.2', () => {})
    await expect(readFile(oldPath)).rejects.toThrow()
    expect([...await readFile(path)]).toEqual([...bytes])
  })

  it('preserves old installers when the updater does not own the directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const oldPath = join(directory, 'old-installer.exe')
    await writeFile(oldPath, 'old installer')
    const { send } = transport(indexFor())
    const port = manualPort(directory, send)
    await port.prepare('1.1.0-rc.2', () => {})
    await expect(readFile(oldPath)).resolves.toEqual(Buffer.from('old installer'))
  })

  it('preserves old installers when feed validation fails before owned-directory cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const oldPath = join(directory, 'old-installer.exe')
    await writeFile(oldPath, 'old installer')
    const { send } = transport(indexFor())
    const port = manualPort(directory, send, { ownsDirectory: true })
    await expect(port.prepare('1.1.0-rc.1', () => {})).rejects.toThrow(/the feed offers 1.1.0-rc.2/u)
    await expect(readFile(oldPath)).resolves.toEqual(Buffer.from('old installer'))
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

  it('removes partial files when the server rejects a resumed request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    let downloads = 0
    const { send } = transport(indexFor(), () => {
      downloads += 1
      return downloads === 1
        ? interruptedResponse(bytes.subarray(0, 4))
        : new Response(null, { status: 416 })
    })
    const port = manualPort(directory, send, { retryDelayMs: 0 })
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/HTTP 416/u)
    await expectDownloadFilesMissing(directory)
  })

  it('resumes an interrupted download with the received byte range and ETag', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const split = Math.floor(bytes.byteLength / 2)
    const etag = '"installer-v1"'
    const requests: (RequestInit | undefined)[] = []
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/latest.json')) return new Response(JSON.stringify(indexFor()))
      requests.push(init)
      if (requests.length === 1) {
        return interruptedResponse(bytes.subarray(0, split), {
          etag, 'content-length': String(bytes.byteLength),
        })
      }
      return new Response(bytes.subarray(split), {
        status: 206,
        headers: { 'content-range': `bytes ${split}-${bytes.byteLength - 1}/${bytes.byteLength}` },
      })
    })
    const port = manualPort(directory, send, { retryDelayMs: 0 })
    const progress: number[] = []
    const path = await port.prepare('1.1.0-rc.2', (value) => { progress.push(value) })

    expect(requests).toHaveLength(2)
    expect(requests[0]).toBeUndefined()
    const resumeHeaders = new Headers(requests[1]?.headers)
    expect(resumeHeaders.get('range')).toBe(`bytes=${split}-`)
    expect(resumeHeaders.get('if-range')).toBe(etag)
    const result = await readFile(path)
    expect([...result]).toEqual([...bytes])
    expect(createHash('sha256').update(result).digest('hex')).toBe(digest)
    expect(progress.at(-1)).toBe(100)
    expect(progress.slice(0, -1).every(value => value < 100)).toBe(true)
    expect(progress.every((value, index) => index === 0 || value > progress[index - 1]!)).toBe(true)
  })

  it('restarts from byte zero when a resume request receives the full file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const split = Math.floor(bytes.byteLength / 2)
    const requests: (RequestInit | undefined)[] = []
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/latest.json')) return new Response(JSON.stringify(indexFor()))
      requests.push(init)
      if (requests.length === 1) return interruptedResponse(bytes.subarray(0, split))
      return new Response(bytes)
    })
    const port = manualPort(directory, send, { retryDelayMs: 0 })
    const path = await port.prepare('1.1.0-rc.2', () => {})
    const result = await readFile(path)
    expect(requests).toHaveLength(2)
    expect(new Headers(requests[1]?.headers).get('range')).toBe(`bytes=${split}-`)
    expect([...result]).toEqual([...bytes])
    expect(createHash('sha256').update(result).digest('hex')).toBe(digest)
  })

  it('rejects a resumed response with the wrong Content-Range and removes partial files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const split = Math.floor(bytes.byteLength / 2)
    let downloads = 0
    const send = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/latest.json')) return new Response(JSON.stringify(indexFor()))
      downloads += 1
      if (downloads === 1) return interruptedResponse(bytes.subarray(0, split))
      return new Response(bytes.subarray(split), {
        status: 206,
        headers: { 'content-range': `bytes ${split + 1}-${bytes.byteLength - 1}/${bytes.byteLength}` },
      })
    })
    const port = manualPort(directory, send, { retryDelayMs: 0 })
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/unexpected Content-Range/u)
    await expectDownloadFilesMissing(directory)
  })

  it('stops after five consecutive interruptions without received bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    let downloads = 0
    const send = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/latest.json')) return new Response(JSON.stringify(indexFor()))
      downloads += 1
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new TypeError(`terminated-${downloads}`)) },
      }))
    })
    const port = manualPort(directory, send, { retryDelayMs: 0 })
    await expect(port.prepare('1.1.0-rc.2', () => {})).rejects.toThrow(/terminated-5/u)
    expect(downloads).toBe(5)
    await expectDownloadFilesMissing(directory)
  })

  it('deletes the artifact when the shell cannot open it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const { send } = transport(indexFor())
    const port = manualPort(directory, send, { openPath: async () => 'no handler' })
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
