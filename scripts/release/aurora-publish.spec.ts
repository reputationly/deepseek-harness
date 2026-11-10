import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { buildIndex, collect, latestName, type AuroraIndex } from './aurora-publish.mjs'

describe('aurora publish artifact grouping', () => {
  it('names the channel feeds packaged clients request', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aurora-publish-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    for (const name of [
      'deepseek-harness-1.0.0-mac-arm64-unsigned.dmg',
      'deepseek-harness-1.0.0-mac-x64-unsigned.dmg',
      'deepseek-harness-1.0.0-win-x64-unsigned.exe',
      'unrelated.txt',
    ]) writeFileSync(join(directory, name), 'x')
    const grouped = collect(directory)
    expect(grouped.get('darwin-arm64')?.feed).toBe('nightly-mac.yml')
    expect(grouped.get('darwin-x64')?.feed).toBe('nightly-mac.yml')
    expect(grouped.get('win32-x64')?.feed).toBe('nightly.yml')
  })
})

describe('floating download names', () => {
  it('drops the version so a page can link to a URL that never changes', () => {
    expect(latestName('suanli-assistant', 'win32-x64', 'deepseek-harness-0.2.2-rc.1.ov.202611091348-win-x64-unsigned.exe'))
      .toBe('suanli-assistant-win32-x64-unsigned.exe')
    expect(latestName('suanli-assistant', 'darwin-arm64', 'deepseek-harness-0.2.2-rc.1.ov.202611091348-mac-arm64-unsigned.dmg'))
      .toBe('suanli-assistant-darwin-arm64-unsigned.dmg')
  })
})

describe('latest index', () => {
  it('points at the immutable directory and describes the bytes it names', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aurora-index-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const installer = 'deepseek-harness-1.0.0-win-x64-unsigned.exe'
    writeFileSync(join(directory, installer), 'hello installer')
    writeFileSync(join(directory, `${installer}.blockmap`), 'blockmap')
    const index = JSON.parse(buildIndex({
      namespace: 'suanli-assistant',
      publicBase: 'https://download.example.test',
      target: 'win32-x64',
      version: '1.0.0',
      feed: 'nightly.yml',
      files: [installer, `${installer}.blockmap`],
      artifacts: directory,
    })) as AuroraIndex
    expect(index.version).toBe('1.0.0')
    expect(index.feed).toBe('https://download.example.test/suanli-assistant/win32-x64/nightly.yml')
    expect(index.files).toHaveLength(1)
    expect(index.files[0]).toMatchObject({
      url: `https://download.example.test/suanli-assistant/win32-x64/versions/1.0.0/${installer}`,
      stableUrl: 'https://download.example.test/suanli-assistant/win32-x64/latest/suanli-assistant-win32-x64-unsigned.exe',
      size: 15,
      sha256: createHash('sha256').update('hello installer').digest('hex'),
    })
  })
})
