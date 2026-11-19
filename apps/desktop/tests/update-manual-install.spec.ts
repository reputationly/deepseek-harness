/** Manual installer handoff: artifact selection, verified download, and the open failure path. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createManualInstall, selectInstallerAsset } from '../src/update-manual-install.ts'

const created: string[] = []
afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

const bytes = Buffer.from('installer-bytes')
const digest = createHash('sha512').update(bytes).digest('base64')

function responder(answer: Response | (() => Response)) {
  return vi.fn(async () => typeof answer === 'function' ? answer() : answer)
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

  it('reports no installer for other platforms or a feed without one', () => {
    expect(selectInstallerAsset(files, 'linux')).toBeUndefined()
    expect(selectInstallerAsset([files[0]!], 'darwin')).toBeUndefined()
  })
})

describe('createManualInstall', () => {
  it('saves the artifact after the published size and SHA-512 match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const port = createManualInstall({
      directory, send: responder(new Response(bytes)), openPath: async () => '',
    })
    const percent: number[] = []
    const path = await port.prepare({ url: 'https://cdn/dmg', name: 'app.dmg', size: bytes.byteLength, sha512: digest },
      (value) => { percent.push(value) })
    expect([...await readFile(path)]).toEqual([...bytes])
    expect(percent).toEqual([100])
  })

  it('rejects a download whose size differs from the feed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const port = createManualInstall({ directory, send: responder(new Response(bytes)), openPath: async () => '' })
    await expect(port.prepare({ url: 'https://cdn/dmg', name: 'app.dmg', size: bytes.byteLength + 1 }, () => {}))
      .rejects.toThrow(/bytes, the feed published/u)
  })

  it('rejects a download whose digest differs from the feed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const port = createManualInstall({ directory, send: responder(new Response(bytes)), openPath: async () => '' })
    await expect(port.prepare({ url: 'https://cdn/dmg', name: 'app.dmg', sha512: 'nope' }, () => {}))
      .rejects.toThrow(/SHA-512/u)
  })

  it('reports a refused download', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const port = createManualInstall({
      directory, send: responder(new Response(null, { status: 403 })), openPath: async () => '',
    })
    await expect(port.prepare({ url: 'https://cdn/dmg', name: 'app.dmg' }, () => {}))
      .rejects.toThrow(/HTTP 403/u)
  })

  it('deletes the artifact when the shell cannot open it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'manual-install-'))
    created.push(directory)
    const port = createManualInstall({ directory, send: responder(new Response(bytes)), openPath: async () => 'no handler' })
    const path = await port.prepare({ url: 'https://cdn/dmg', name: 'app.dmg' }, () => {})
    await expect(port.open(path)).rejects.toThrow(/could not be opened: no handler/u)
    await expect(readFile(path)).rejects.toThrow()
  })
})
