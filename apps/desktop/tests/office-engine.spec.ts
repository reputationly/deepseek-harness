/** Provisioning of the LibreOffice engine package a packaged release downloads. */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { c as createArchive } from 'tar'
import { afterEach, expect, it } from 'vitest'
import {
  OFFICE_ENGINE_FILE, OFFICE_ENGINE_REGISTRIES, ensureOfficeEngine, officeEngineDirectory, readOfficeEngineSpec,
  type OfficeEngineSpec,
} from '../src/office-engine.ts'

const NAME = '@deepseek-ai/libreoffice-kit-darwin-arm64'
const VERSION = '0.2.3'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-office-engine-'))
  roots.push(root)
  return root
}

async function engineArchive(root: string, manifest: { name: string; version: string }): Promise<Buffer> {
  const packageRoot = join(root, 'archive-package')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest)}\n`)
  const file = join(root, 'engine.tgz')
  await createArchive({ file, cwd: root, gzip: true, portable: true }, ['archive-package'])
  return readFile(file)
}

function integrityOf(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** Serve the recorded tarball at npm's package path on a loopback port this spec owns. */
async function serve(bytes: Buffer | undefined): Promise<{ registry: string; server: Server }> {
  const server = createServer((request, response) => {
    if (bytes === undefined || !request.url?.endsWith(`/${NAME}/-/${NAME.split('/').at(-1)}-${VERSION}.tgz`)) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytes)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as { port: number }
  afterEach(() => new Promise<void>((resolve) => { server.close(() => { resolve() }) }))
  return { registry: `http://127.0.0.1:${String(port)}/`, server }
}

it('reads the release engine identity beside the runtime descriptor', async () => {
  const root = await scratch()
  expect(await readOfficeEngineSpec(root)).toBeUndefined()
  const spec = { schemaVersion: 1, name: NAME, version: VERSION, integrity: `sha512-${'A'.repeat(86)}==` }
  await writeFile(join(root, OFFICE_ENGINE_FILE), JSON.stringify(spec))
  expect(await readOfficeEngineSpec(root)).toEqual(spec)
})

it.each([
  ['not an object', 'null'],
  ['another schema', JSON.stringify({ schemaVersion: 2, name: NAME, version: VERSION, integrity: 'sha512-AA==' })],
  ['no package name', JSON.stringify({ schemaVersion: 1, name: 'plain', version: VERSION, integrity: 'sha512-AA==' })],
  ['no version', JSON.stringify({ schemaVersion: 1, name: NAME, version: '', integrity: 'sha512-AA==' })],
  ['an unusable integrity', JSON.stringify({ schemaVersion: 1, name: NAME, version: VERSION, integrity: 'sha1-AA==' })],
])('rejects a spec with %s', async (_case, text) => {
  const root = await scratch()
  await writeFile(join(root, OFFICE_ENGINE_FILE), text)
  await expect(readOfficeEngineSpec(root)).rejects.toThrow('desktop office engine')
})

it('places engine packages under the Harness home', () => {
  expect(officeEngineDirectory(join('/home', 'dsh'))).toBe(join('/home', 'dsh', 'dsh-runtimes', 'office-kit'))
  expect(OFFICE_ENGINE_REGISTRIES[0]).toBe('https://registry.npmjs.org/')
})

it('reuses an installed engine package without asking a registry', async () => {
  const root = await scratch()
  const directory = officeEngineDirectory(root)
  const installed = join(directory, NAME)
  await mkdir(installed, { recursive: true })
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: NAME, version: VERSION }))
  const spec: OfficeEngineSpec = { schemaVersion: 1, name: NAME, version: VERSION, integrity: `sha512-${'A'.repeat(86)}==` }
  await expect(ensureOfficeEngine({ spec, directory, registries: ['http://127.0.0.1:1/'] }))
    .resolves.toEqual({ directory: installed, installed: false })
})

it('downloads, verifies, and unpacks the locked engine package', async () => {
  const root = await scratch()
  const bytes = await engineArchive(root, { name: NAME, version: VERSION })
  const { registry } = await serve(bytes)
  const directory = officeEngineDirectory(root)
  const messages: string[] = []
  const spec: OfficeEngineSpec = { schemaVersion: 1, name: NAME, version: VERSION, integrity: integrityOf(bytes) }
  const provision = await ensureOfficeEngine({ spec, directory, registries: [registry], log: message => messages.push(message) })
  expect(provision).toEqual({ directory: join(directory, NAME), installed: true })
  expect(JSON.parse(await readFile(join(provision.directory, 'package.json'), 'utf8'))).toEqual({ name: NAME, version: VERSION })
  expect(messages.at(-1)).toContain(`installed ${NAME}@${VERSION}`)
  const again = await ensureOfficeEngine({ spec, directory, registries: [registry] })
  expect(again.installed).toBe(false)
})

it('falls back to the next registry when the first cannot answer', async () => {
  const root = await scratch()
  const bytes = await engineArchive(root, { name: NAME, version: VERSION })
  const { registry } = await serve(bytes)
  const { registry: unreachable } = await serve(undefined)
  const directory = officeEngineDirectory(root)
  const spec: OfficeEngineSpec = { schemaVersion: 1, name: NAME, version: VERSION, integrity: integrityOf(bytes) }
  await expect(ensureOfficeEngine({ spec, directory, registries: [unreachable, registry] }))
    .resolves.toMatchObject({ installed: true })
})

it.each([
  ['an integrity mismatch', { name: NAME, version: VERSION }, `sha512-${'A'.repeat(86)}==`, 'integrity mismatch'],
  ['another package version', { name: NAME, version: '9.9.9' }, undefined, 'declares'],
])('rejects the archive when it has %s', async (_case, manifest, integrity, message) => {
  const root = await scratch()
  const bytes = await engineArchive(root, manifest)
  const { registry } = await serve(bytes)
  const directory = officeEngineDirectory(root)
  const spec: OfficeEngineSpec = { schemaVersion: 1, name: NAME, version: VERSION, integrity: integrity ?? integrityOf(bytes) }
  await expect(ensureOfficeEngine({ spec, directory, registries: [registry] })).rejects.toThrow(`could not install ${NAME}@${VERSION}`)
  await expect(readFile(join(directory, NAME, 'package.json'), 'utf8')).rejects.toThrow()
  expect(message).toBeDefined()
})

it('reports every registry failure when none can install the engine', async () => {
  const root = await scratch()
  const directory = officeEngineDirectory(root)
  const { registry } = await serve(undefined)
  const spec: OfficeEngineSpec = { schemaVersion: 1, name: NAME, version: VERSION, integrity: `sha512-${'A'.repeat(86)}==` }
  const logged: string[] = []
  const failure = await ensureOfficeEngine({ spec, directory, registries: [registry, registry], log: message => logged.push(message) })
    .catch((error: unknown) => error)
  expect(String(failure)).toContain(`could not install ${NAME}@${VERSION}`)
  expect(logged).toHaveLength(2)
})
