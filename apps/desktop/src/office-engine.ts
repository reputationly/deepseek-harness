/** Provision the native LibreOffice engine that a packaged Desktop release no longer ships. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Release metadata naming the engine package the packaged runtime expects to download. */
export const OFFICE_ENGINE_FILE = 'office-engine.json'

/** Locked identity of one engine package: its published name, version, and npm tarball integrity. */
export interface OfficeEngineSpec {
  readonly schemaVersion: 1
  readonly name: string
  readonly version: string
  readonly integrity: string
}

/** Registries asked in order, where the first answer that verifies wins. */
export const OFFICE_ENGINE_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/']

const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u

/**
 * Read the release's engine identity beside the runtime descriptor.
 * @param runtimeRoot - Packaged dsh runtime directory.
 * @returns The validated spec, or undefined when this release ships its engine inline.
 * @throws When the file exists but names an unusable identity.
 */
export async function readOfficeEngineSpec(runtimeRoot: string): Promise<OfficeEngineSpec | undefined> {
  let text: string
  try {
    text = await readFile(join(runtimeRoot, OFFICE_ENGINE_FILE), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) throw new Error('desktop office engine: the spec is not an object')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) throw new Error('desktop office engine: unsupported spec schemaVersion')
  const { name, version, integrity } = record
  if (typeof name !== 'string' || !name.includes('/')) throw new Error('desktop office engine: the spec has no package name')
  if (typeof version !== 'string' || version === '') throw new Error('desktop office engine: the spec has no version')
  if (typeof integrity !== 'string' || !INTEGRITY.test(integrity)) {
    throw new Error('desktop office engine: the spec integrity is not an npm SHA-512 integrity')
  }
  return { schemaVersion: 1, name, version, integrity }
}

/**
 * Directory whose direct entries are provisioned engine packages.
 * @param dshHome - Product-owned Harness home.
 * @returns Absolute engine directory the Host profile receives as `DSH_OFFICE_ENGINE_DIR`.
 */
export function officeEngineDirectory(dshHome: string): string {
  return join(dshHome, 'dsh-runtimes', 'office-kit')
}

/** Result of provisioning one engine package. */
export interface OfficeEngineProvision {
  /** Absolute installed package directory. */
  readonly directory: string
  /** Whether this call downloaded the package instead of reusing an installed one. */
  readonly installed: boolean
}

/**
 * Ensure the pinned engine package is installed under the engine directory, downloading it when absent.
 * The caller keeps this off the startup path: a conversion that arrives first reports `unavailable`, and the next one
 * succeeds once the package is in place, because the provider resolves engines on every converter creation.
 * @param options - Locked spec, destination directory, and optional registry order and logger.
 * @returns The installed package directory.
 * @throws When every registry fails, when the tarball does not match its locked integrity, or when the package
 * inside does not declare the locked name and version.
 */
export async function ensureOfficeEngine(options: {
  readonly spec: OfficeEngineSpec
  readonly directory: string
  readonly registries?: readonly string[]
  readonly log?: (message: string) => void
}): Promise<OfficeEngineProvision> {
  const { spec, directory } = options
  const registries = options.registries ?? OFFICE_ENGINE_REGISTRIES
  const target = join(directory, spec.name)
  if (await declaresVersion(target, spec)) return { directory: target, installed: false }
  await mkdir(directory, { recursive: true })
  const staging = await mkdtemp(join(directory, '.staging-'))
  const failures: unknown[] = []
  try {
    for (const registry of registries) {
      const url = `${registry.endsWith('/') ? registry : `${registry}/`}${spec.name}/-/${basename(spec.name)}-${spec.version}.tgz`
      const archive = join(staging, 'engine.tgz')
      const unpacked = join(staging, 'package')
      try {
        await downloadVerified(url, archive, spec.integrity)
        await unpackArchive(archive, unpacked)
        await assertDeclared(unpacked, spec)
        await mkdir(dirname(target), { recursive: true })
        await rm(target, { recursive: true, force: true })
        await rename(unpacked, target)
        options.log?.(`desktop office engine: installed ${spec.name}@${spec.version}`)
        return { directory: target, installed: true }
      } catch (error) {
        failures.push(error)
        options.log?.(`desktop office engine: ${url} failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        await rm(unpacked, { recursive: true, force: true })
        await rm(archive, { force: true })
      }
    }
    throw new Error(`desktop office engine: could not install ${spec.name}@${spec.version}`, { cause: new AggregateError(failures) })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function declaresVersion(directory: string, spec: OfficeEngineSpec): Promise<boolean> {
  try {
    const manifest = await readManifest(directory)
    return manifest.name === spec.name && manifest.version === spec.version
  } catch {
    return false
  }
}

async function readManifest(directory: string): Promise<{ name?: unknown; version?: unknown }> {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
}

async function assertDeclared(directory: string, spec: OfficeEngineSpec): Promise<void> {
  const manifest = await readManifest(directory)
  if (manifest.name !== spec.name || manifest.version !== spec.version) {
    throw new Error(`desktop office engine: the archive declares ${String(manifest.name)}@${String(manifest.version)}`)
  }
}

async function downloadVerified(url: string, destination: string, integrity: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (actual !== integrity) throw new Error(`integrity mismatch: expected ${integrity}`)
  await writeFile(destination, bytes, { flag: 'wx' })
}

async function unpackArchive(archive: string, destination: string): Promise<void> {
  const { x } = await import('tar')
  await mkdir(destination, { recursive: true })
  await x({ file: archive, cwd: destination, strip: 1 })
}
