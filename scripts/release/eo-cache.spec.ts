import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { planFromIndex } from './eo-cache.mjs'

function indexFile(body: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'eo-cache-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'win32-x64-latest.json')
  writeFileSync(path, JSON.stringify(body))
  return path
}

describe('EdgeOne cache plan', () => {
  it('pre-warms the immutable installers and refreshes the pointers that name them', () => {
    const plan = planFromIndex(indexFile({
      version: '1.0.0',
      feed: 'https://cdn.test/suanli-assistant/win32-x64/nightly.yml',
      files: [{
        url: 'https://cdn.test/suanli-assistant/win32-x64/versions/1.0.0/app.exe',
        stableUrl: 'https://cdn.test/suanli-assistant/win32-x64/latest/app.exe',
      }],
    }))
    expect(plan.warm).toEqual(['https://cdn.test/suanli-assistant/win32-x64/versions/1.0.0/app.exe'])
    expect(plan.refresh).toEqual([
      'https://cdn.test/suanli-assistant/win32-x64/nightly.yml',
      'https://cdn.test/suanli-assistant/win32-x64/latest/app.exe',
      'https://cdn.test/suanli-assistant/win32-x64/latest.json',
    ])
  })

  it('keeps one entry per URL when a target lists the same file twice', () => {
    const plan = planFromIndex(indexFile({
      feed: 'https://cdn.test/x/nightly.yml',
      files: [
        { url: 'https://cdn.test/x/versions/1/app.exe', stableUrl: 'https://cdn.test/x/latest/app.exe' },
        { url: 'https://cdn.test/x/versions/1/app.exe', stableUrl: 'https://cdn.test/x/latest/app.exe' },
      ],
    }))
    expect(plan.warm).toHaveLength(1)
    expect(plan.refresh).toHaveLength(3)
  })
})
