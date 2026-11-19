import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { externalPackages, stageExternalPackages } from '../scripts/stage-external-packages.ts'

const url = 'https://example.com/releases/abc/plugin-1.2.0-fork.1.tgz'
const body = new TextEncoder().encode('release tarball bytes')
const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`

function manifest(dependencies: Record<string, string>): string {
  return JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.0', dependencies })
}

function lockfile(entries: Record<string, string>): string {
  return `packages:\n${Object.entries(entries).map(([key, value]) => `  '${key}':\n    resolution: {integrity: ${value}, tarball: ${url}}\n`).join('')}`
}

describe('external Desktop packages', () => {
  const directories: string[] = []
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
  const scratch = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-external-packages-'))
    directories.push(directory)
    return directory
  }

  it('lists only dependencies declared as tarball URLs, with the integrity the lockfile pins', () => {
    const packages = externalPackages(manifest({ '@scope/plugin': url, registry: '1.0.0', local: 'workspace:*' }), lockfile({ [`@scope/plugin@${url}`]: integrity }))
    expect(packages).toEqual([{ name: '@scope/plugin', url, file: 'plugin-1.2.0-fork.1.tgz', integrity }])
  })

  it('lists nothing when dsh has no URL dependency', () => {
    expect(externalPackages(manifest({ registry: '1.0.0' }), 'packages: {}\n')).toEqual([])
  })

  it('refuses a URL dependency the lockfile does not pin', () => {
    expect(() => externalPackages(manifest({ '@scope/plugin': url }), 'packages: {}\n')).toThrow(/pins no sha512 integrity for @scope\/plugin/u)
  })

  it('refuses a URL without a tarball filename', () => {
    const bare = 'https://example.com/download?id=1'
    expect(() => externalPackages(manifest({ plugin: bare }), `packages:\n  'plugin@${bare}':\n    resolution: {integrity: ${integrity}}\n`))
      .toThrow(/no usable tarball filename/u)
  })

  it('writes a tarball whose bytes match the lockfile', async () => {
    const destination = join(scratch(), 'packed')
    const staged = await stageExternalPackages([{ name: '@scope/plugin', url, file: 'plugin-1.2.0-fork.1.tgz', integrity }], destination, () => Promise.resolve(body))
    expect(staged).toEqual(['plugin-1.2.0-fork.1.tgz'])
    expect(readFileSync(join(destination, 'plugin-1.2.0-fork.1.tgz'))).toEqual(Buffer.from(body))
  })

  it('rejects changed bytes without writing them', async () => {
    const destination = join(scratch(), 'packed')
    await expect(stageExternalPackages([{ name: '@scope/plugin', url, file: 'plugin-1.2.0-fork.1.tgz', integrity }], destination,
      () => Promise.resolve(new TextEncoder().encode('other bytes')))).rejects.toThrow(/does not match the integrity the lockfile pins/u)
    expect(existsSync(join(destination, 'plugin-1.2.0-fork.1.tgz'))).toBe(false)
  })
})
