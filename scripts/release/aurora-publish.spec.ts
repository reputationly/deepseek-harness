import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { collect } from './aurora-publish.mjs'

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
