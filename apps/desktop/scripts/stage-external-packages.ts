/**
 * Stage the release tarballs the dsh package depends on by URL beside the packed first-party tarballs, so the Desktop
 * package set supplies them as local files. The independent Desktop installation resolves dsh from a local tarball,
 * which makes these dependencies transitive, and pnpm refuses a transitive dependency resolved through a URL.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'

const DSH_MANIFEST = 'apps/cli/package.json'
const FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u

/** One URL dependency of dsh with the integrity the repository lockfile pins. */
export interface ExternalPackage {
  readonly name: string
  readonly url: string
  readonly file: string
  readonly integrity: string
}

interface Lockfile {
  packages?: Record<string, { resolution?: { integrity?: unknown; tarball?: unknown } }>
}

/**
 * List the dsh dependencies declared as release tarball URLs.
 * @param manifestText - Text of the dsh package manifest.
 * @param lockfileText - Text of the repository lockfile that pins each tarball.
 * @returns The tarballs to stage, in name order.
 */
export function externalPackages(manifestText: string, lockfileText: string): ExternalPackage[] {
  const manifest = JSON.parse(manifestText) as { dependencies?: Record<string, string> }
  const lockfile = yaml.load(lockfileText) as Lockfile
  return Object.entries(manifest.dependencies ?? {})
    .filter(([, spec]) => /^https?:\/\//u.test(spec))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, url]) => {
      const integrity = lockfile.packages?.[`${name}@${url}`]?.resolution?.integrity
      if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
        throw new Error(`desktop external packages: the lockfile pins no sha512 integrity for ${name}`)
      }
      const file = new URL(url).pathname.split('/').at(-1) ?? ''
      if (!FILE_PATTERN.test(file)) throw new Error(`desktop external packages: ${name} has no usable tarball filename in ${url}`)
      return { name, url, file, integrity }
    })
}

/**
 * Download each tarball, check it against the lockfile, and write it into the staging directory.
 * @param packages - Tarballs to stage.
 * @param destination - Directory that holds packed tarballs for the Desktop package set.
 * @param download - Reads the bytes behind a URL.
 * @returns The staged filenames.
 */
export async function stageExternalPackages(
  packages: readonly ExternalPackage[],
  destination: string,
  download: (url: string) => Promise<Uint8Array>,
): Promise<string[]> {
  mkdirSync(destination, { recursive: true })
  const staged: string[] = []
  for (const entry of packages) {
    const body = await download(entry.url)
    const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`
    if (integrity !== entry.integrity) {
      throw new Error(`desktop external packages: ${entry.url} does not match the integrity the lockfile pins for ${entry.name}`)
    }
    writeFileSync(join(destination, entry.file), body)
    staged.push(entry.file)
  }
  return staged
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`desktop external packages: ${url} answered ${String(response.status)}`)
  return new Uint8Array(await response.arrayBuffer())
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: false })
  if (values.out === undefined) throw new Error('desktop external packages: --out must name the package staging directory')
  const root = process.cwd()
  const packages = externalPackages(readFileSync(join(root, DSH_MANIFEST), 'utf8'), readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
  const staged = await stageExternalPackages(packages, resolve(root, values.out), fetchBytes)
  console.log(`desktop external packages: ${String(staged.length)} tarball(s) staged${staged.length === 0 ? '' : `: ${staged.join(', ')}`}`)
}

if (import.meta.main) await main()
