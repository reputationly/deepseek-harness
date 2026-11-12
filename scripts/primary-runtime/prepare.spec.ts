import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'
import { expect, it, vi } from 'vitest'
import { downloadPrimaryRuntimeAsset, prepareFfmpegAssets, prepareMediaEditingSkillAssets, prepareOfficeSkillAssets, primaryRuntimePayloadDigest, prunePnpmForeignNativePackages, smokePrimaryRuntime, unpackPrimaryRuntimeWheel } from './prepare.ts'
import lock from './lock.json' with { type: 'json' }

it('covers every SDK wheel target with the shared interpreter lock', () => {
  const platforms = JSON.parse(readFileSync(new URL('../../python/sdk-runtime/platforms.json', import.meta.url), 'utf8')) as Record<string, unknown>
  expect(Object.keys(lock.targets).sort()).toEqual(Object.keys(platforms).map(target => target.replace('macos-', 'mac-')).sort())
})

it('locks ffmpeg-static assets only for mac-arm64 and win-x64', () => {
  expect(lock.targets['mac-arm64'].ffmpeg).toEqual({
    ffmpeg: {
      url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-darwin-arm64.gz',
      sha256: '6be74d6f449889c2e87a75873894f8520cad56c08ac76f2a628d85b0519daaca',
    },
    ffprobe: {
      url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffprobe-darwin-arm64.gz',
      sha256: 'a4db76bafdb8529312e138fb55aaf143cad21b6d672e2634c9dd07ae83c6a310',
    },
  })
  expect(lock.targets['win-x64'].ffmpeg.ffmpeg.url).toContain('ffmpeg-win32-x64.gz')
  expect('ffmpeg' in lock.targets['linux-x64']).toBe(false)
})

it('verifies, decompresses, and stages target ffmpeg executables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primary-ffmpeg-'))
  const runtimeLock = structuredClone(lock)
  const archives = new Map<string, Buffer>()
  for (const target of ['mac-arm64', 'win-x64'] as const) {
    for (const name of ['ffmpeg', 'ffprobe'] as const) {
      const url = `https://assets.example/${target}/${name}.gz`
      const bytes = gzipSync(Buffer.from(`${target}-${name}`))
      runtimeLock.targets[target].ffmpeg[name] = {
        url,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      archives.set(url, bytes)
    }
  }
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const bytes = archives.get(url)
    if (bytes === undefined) throw new Error('unexpected locked asset')
    return new Response(new Blob([Uint8Array.from(bytes)]))
  })
  try {
    const mac = join(root, 'primary-runtime', 'ffmpeg')
    await prepareFfmpegAssets('mac-arm64', mac, join(root, 'cache'), runtimeLock)
    expect(await readFile(join(mac, 'ffmpeg'), 'utf8')).toBe('mac-arm64-ffmpeg')
    expect(((await stat(join(mac, 'ffprobe'))).mode & 0o111) !== 0).toBe(true)
    const windows = join(root, 'windows', 'ffmpeg')
    await prepareFfmpegAssets('win-x64', windows, join(root, 'cache'), runtimeLock)
    expect(await readFile(join(windows, 'ffmpeg.exe'), 'utf8')).toBe('win-x64-ffmpeg')
    expect(await readFile(join(windows, 'ffprobe.exe'), 'utf8')).toBe('win-x64-ffprobe')
  } finally {
    fetchSpy.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

const libraryWheel = Buffer.from('UEsDBAoAAAAAAASeLl0sYMPjDAAAAAwAAAAJAAAAc2FtcGxlLnB5c2FtcGxlID0gNDIKUEsBAh4DCgAAAAAABJ4uXSxgw+MMAAAADAAAAAkAAAAAAAAAAQAAAKSBAAAAAHNhbXBsZS5weVBLBQYAAAAAAQABADcAAAAzAAAAAAA=', 'base64')
const relocatedWheel = Buffer.from('UEsDBAoAAAAAAASeLl3x0Nj9FAAAABQAAAAeAAAAc2FtcGxlLTEuMC5kYXRhL3NjcmlwdHMvc2FtcGxlcmVxdWlyZXMgcmVsb2NhdGlvbgpQSwECHgMKAAAAAAAEni5d8dDY/RQAAAAUAAAAHgAAAAAAAAABAAAApIEAAAAAc2FtcGxlLTEuMC5kYXRhL3NjcmlwdHMvc2FtcGxlUEsFBgAAAAABAAEATAAAAFAAAAAAAA==', 'base64')
const externalLibraryWheel = Buffer.from('UEsDBBQAAAAAAAAAIVyBOE8OHAAAABwAAAAhAAAAc2FtcGxlLTEuMC5kYXRhL3B1cmVsaWIvc2FtcGxlLnB5cmVxdWlyZXMgbGlicmFyeSByZWxvY2F0aW9uClBLAQIUAxQAAAAAAAAAIVyBOE8OHAAAABwAAAAhAAAAAAAAAAAAAACAAQAAAABzYW1wbGUtMS4wLmRhdGEvcHVyZWxpYi9zYW1wbGUucHlQSwUGAAAAAAEAAQBPAAAAWwAAAAAA', 'base64')

it.each(Object.entries(lock.targets))('records every locked wheel distribution and version for %s', (_target, artifact) => {
  const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]+/gu, '-')
  const distributions = [...artifact.wheels, ...lock.wheels].map(({ url }) => {
    const [name, version] = basename(new URL(url).pathname).split('-')
    return [normalize(name!), version] as const
  })
  const declared = Object.entries(lock.pythonPackages).map(([name, version]) => [normalize(name), version] as const)
  expect(new Set(distributions.map(([name]) => name)).size).toBe(distributions.length)
  expect(new Set(declared.map(([name]) => name)).size).toBe(declared.length)
  expect(Object.fromEntries(distributions)).toEqual(Object.fromEntries(declared))
})

it('keeps a target payload identity independent of other target archives', () => {
  const changed = structuredClone(lock)
  changed.targets['win-x64'].wheels[0]!.sha256 = 'a'.repeat(64)
  expect(primaryRuntimePayloadDigest('mac-arm64', changed, '11.7.0')).toBe(primaryRuntimePayloadDigest('mac-arm64', lock, '11.7.0'))
  expect(primaryRuntimePayloadDigest('win-x64', changed, '11.7.0')).not.toBe(primaryRuntimePayloadDigest('win-x64', lock, '11.7.0'))
  const ffmpeg = structuredClone(lock)
  ffmpeg.targets['mac-arm64'].ffmpeg.ffmpeg.sha256 = 'b'.repeat(64)
  expect(primaryRuntimePayloadDigest('mac-arm64', ffmpeg, '11.7.0')).not.toBe(primaryRuntimePayloadDigest('mac-arm64', lock, '11.7.0'))
})

it('invalidates payload identity for shared wheels, package versions and package-manager changes', () => {
  const wheel = structuredClone(lock), distribution = structuredClone(lock)
  wheel.wheels[0]!.sha256 = 'a'.repeat(64)
  distribution.pythonPackages['python-docx'] = '1.2.1'
  const original = primaryRuntimePayloadDigest('mac-arm64', lock, '11.7.0')
  expect(primaryRuntimePayloadDigest('mac-arm64', wheel, '11.7.0')).not.toBe(original)
  expect(primaryRuntimePayloadDigest('mac-arm64', distribution, '11.7.0')).not.toBe(original)
  expect(primaryRuntimePayloadDigest('mac-arm64', lock, '11.7.1')).not.toBe(original)
})

it('reports missing distribution metadata before trying to execute a stale native payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-stale-runtime-'))
  try {
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
      components: { python: '3.12.14', numpy: '2.3.5', pandas: '3.0.1' } }))
    expect(() => { smokePrimaryRuntime(root) }).toThrow('missing Python distribution versions; prepare the payload')
  } finally { await rm(root, { recursive: true, force: true }) }
})

// Native Windows payloads require python.exe rather than POSIX interpreter aliases.
it.skipIf(process.platform === 'win32')('rejects expanded interpreter aliases in the native payload smoke', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primary-expanded-aliases-'))
  try {
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ desktopVersion: '1', platform: process.platform, arch: process.arch,
      python: '3.12.14', pythonPackages: { numpy: '2.3.5' } }))
    await mkdir(join(root, 'dependencies/python/bin'), { recursive: true })
    for (const name of ['python', 'python3', 'python3.12']) await writeFile(join(root, 'dependencies/python/bin', name), 'interpreter')
    expect(() => { smokePrimaryRuntime(root) }).toThrow('Python commands must be relative aliases')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('extracts a hash-verified cached library without a Python installer or network request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-wheel-'))
  try {
    const hash = createHash('sha256').update(libraryWheel).digest('hex')
    const archive = join(root, hash)
    await writeFile(archive, libraryWheel)
    const original = await stat(archive)
    expect(await downloadPrimaryRuntimeAsset('https://unused.invalid/library.whl', hash, root)).toBe(archive)
    const reused = await stat(archive)
    expect(reused.ino).toBe(original.ino)
    expect(reused.mtimeMs).toBe(original.mtimeMs)
    await unpackPrimaryRuntimeWheel(archive, join(root, 'site-packages'))
    expect(await readFile(join(root, 'site-packages/sample.py'), 'utf8')).toBe('sample = 42\n')
    await writeFile(archive, 'corrupt archive')
    await expect(downloadPrimaryRuntimeAsset('https://unused.invalid/library.whl', hash, root)).rejects.toThrow('checksum mismatch')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('fully extracts a large deflate-compressed wheel entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-large-wheel-'))
  try {
    const expected = Buffer.alloc(1024 * 1024)
    // Seeded xorshift bytes keep the compressed entry larger than the stream buffers.
    let state = 26
    for (let index = 0; index < expected.length; index++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      expected[index] = state & 255
    }
    const archive = join(root, 'large.whl')
    await writeFile(archive, zipSync({ 'large.bin': expected }, { level: 6 }))
    await unpackPrimaryRuntimeWheel(archive, root)
    // Native byte equality avoids a per-byte matcher traversal for this 1 MiB expected output.
    expect((await readFile(join(root, 'large.bin'))).equals(expected)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retains auxiliary wheel scripts without generating command wrappers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-wheel-'))
  try {
    const archive = join(root, 'relocated.whl')
    await writeFile(archive, relocatedWheel)
    await unpackPrimaryRuntimeWheel(archive, join(root, 'site-packages'))
    expect(await readFile(join(root, 'site-packages/sample-1.0.data/scripts/sample'), 'utf8')).toBe('requires relocation\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects library files requiring an unsupported installation scheme', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-wheel-'))
  try {
    const archive = join(root, 'relocated.whl')
    await writeFile(archive, externalLibraryWheel)
    await expect(unpackPrimaryRuntimeWheel(archive, join(root, 'site-packages'))).rejects.toThrow('unsupported installation paths')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('copies complete Office resources outside the application archive and removes obsolete assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-office-assets-'))
  try {
    const source = join(root, 'package', 'assets')
    const destination = join(root, 'Contents', 'Resources', 'runtime', 'office-skills')
    await mkdir(source, { recursive: true })
    for (const name of ['office-docx', 'office-pptx', 'office-xlsx']) {
      await mkdir(join(source, name))
      await writeFile(join(source, name, 'SKILL.md'), `# ${name}\n`)
    }
    await prepareOfficeSkillAssets(source, destination)
    await writeFile(join(destination, 'obsolete.py'), 'old helper')
    await prepareOfficeSkillAssets(source, destination)
    for (const name of ['office-docx', 'office-pptx', 'office-xlsx']) {
      expect(await readFile(join(destination, name, 'SKILL.md'), 'utf8')).toBe(`# ${name}\n`)
    }
    await expect(readFile(join(destination, 'obsolete.py'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('copies the media-editing skill beside primary-runtime for packaged dsh discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-media-skill-'))
  try {
    const source = join(root, 'package', 'assets', 'media-editing')
    const destination = join(root, 'Contents', 'Resources', 'runtime', 'media-editing')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '# Media editing\n')
    await prepareMediaEditingSkillAssets(source, destination)
    await writeFile(join(destination, 'obsolete.txt'), 'old')
    await prepareMediaEditingSkillAssets(source, destination)
    expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('# Media editing\n')
    await expect(readFile(join(destination, 'obsolete.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('gives Python-only payloads a distinct identity', () => {
  expect(primaryRuntimePayloadDigest('linux-x64', lock, undefined)).not.toBe(primaryRuntimePayloadDigest('linux-x64', lock, '11.7.0'))
})

it('keeps carrier pnpm versions aligned with the shared payload build', () => {
  const root = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    packageManager: string
    devDependencies: { pnpm: string }
  }
  const desktop = JSON.parse(readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')) as {
    devDependencies: { pnpm: string }
  }
  expect(desktop.devDependencies.pnpm).toBe(root.devDependencies.pnpm)
  expect(root.packageManager).toBe(`pnpm@${root.devDependencies.pnpm}`)
})

it.each([
  ['darwin', 'arm64', ['reflink', 'reflink-darwin-arm64'], ['.bin', '@reflink', 'any-cpu', 'not-windows', 'semver']],
  ['darwin', 'x64', ['reflink', 'reflink-darwin-x64'], ['.bin', '@reflink', 'any-cpu', 'not-windows', 'semver']],
  ['win32', 'x64', ['reflink', 'reflink-win32-x64-msvc'], ['.bin', '@reflink', 'any-cpu', 'not-darwin', 'semver']],
] as const)('keeps only pnpm-bundled packages that %s/%s admits', async (platform, arch, reflink, top) => {
  const root = await mkdtemp(join(tmpdir(), 'primary-pnpm-natives-'))
  try {
    const modules = join(root, 'dist', 'node_modules')
    const packages: Record<string, { os?: string[]; cpu?: string[] }> = {
      'semver': {}, '@reflink/reflink': {}, 'any-cpu': { cpu: ['any'] },
      '@reflink/reflink-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
      '@reflink/reflink-darwin-x64': { os: ['darwin'], cpu: ['x64'] },
      '@reflink/reflink-win32-x64-msvc': { os: ['win32'], cpu: ['x64'] },
      'not-windows': { os: ['!win32'] },
      'not-darwin': { os: ['!darwin'] },
      'contradictory': { os: ['darwin', 'win32', '!darwin', '!win32'] },
    }
    for (const [name, fields] of Object.entries(packages)) {
      await mkdir(join(modules, name), { recursive: true })
      await writeFile(join(modules, name, 'package.json'), JSON.stringify({ name, ...fields }))
    }
    await mkdir(join(modules, '.bin'))
    await writeFile(join(modules, '.modules.yaml'), '')
    prunePnpmForeignNativePackages(root, platform, arch)
    expect((await readdir(modules)).filter(name => name !== '.modules.yaml').sort()).toEqual(top)
    expect((await readdir(join(modules, '@reflink'))).sort()).toEqual(reflink)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('names the bundled manifest whose platform field is invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primary-pnpm-invalid-'))
  try {
    await mkdir(join(root, 'dist', 'node_modules', 'invalid'), { recursive: true })
    await writeFile(join(root, 'dist', 'node_modules', 'invalid', 'package.json'), JSON.stringify({ os: 'darwin' }))
    expect(() => { prunePnpmForeignNativePackages(root, 'darwin', 'arm64') }).toThrow(/invalid.package\.json: npm platform constraints must be arrays of strings/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
