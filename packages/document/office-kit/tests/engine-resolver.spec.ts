/** The provider's actual Kit installation is the reference for engine package resolution. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installedEngineManifest, resolveKitModule } from '../src/locate.ts'
import { expect, it } from 'vitest'

it('matches the consumer Kit installation for native and WASM engine manifests', () => {
  const kitEntry = import.meta.resolve('@deepseek-ai/libreoffice-kit')
  const fromKit = createRequire(kitEntry)
  const kit = resolveKitModule(() => import.meta.resolve('@deepseek-ai/libreoffice-kit'))
  if (kit.kind !== 'available') throw new Error('Expected the provider Kit installation')
  expect(kit.entry).toBe(kitEntry)
  const { resolveEnginePackage } = kit
  const outcome = (resolve: (name: string) => string, name: string): string => {
    try { return resolve(name) } catch (error) {
      if (error instanceof Error && 'code' in error) return String(error.code)
      throw error
    }
  }
  for (const name of ['@deepseek-ai/libreoffice-kit-wasm', `@deepseek-ai/libreoffice-kit-${process.platform}-${process.arch}`]) {
    const expected = outcome(name => fromKit.resolve(`${name}/package.json`), name)
    expect(outcome(resolveEnginePackage, name)).toBe(expected)
  }
})

it('locates a provisioned engine manifest inside its deployment directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-engine-dir-'))
  try {
    expect(installedEngineManifest(root, '@deepseek-ai/libreoffice-kit-wasm')).toBeUndefined()
    const manifest = join(root, '@deepseek-ai/libreoffice-kit-wasm', 'package.json')
    await mkdir(dirname(manifest), { recursive: true })
    await writeFile(manifest, '{}\n')
    expect(installedEngineManifest(root, '@deepseek-ai/libreoffice-kit-wasm')).toBe(manifest)
    expect(installedEngineManifest(root, '@deepseek-ai/libreoffice-kit-darwin-arm64')).toBeUndefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
