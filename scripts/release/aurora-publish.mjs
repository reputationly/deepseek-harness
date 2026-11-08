/**
 * Publish one completed Aurora build to the installer bucket.
 *
 * Layout: every target keeps a mutable pointer beside immutable version directories.
 *
 *   suanli-assistant/darwin-arm64/latest-mac.yml                     <- update pointer, rewritten per release
 *   suanli-assistant/darwin-arm64/latest/<installer>                 <- floating download, overwritten
 *   suanli-assistant/darwin-arm64/versions/<version>/<installer>     <- immutable, one directory per build
 *   suanli-assistant/win32-x64/latest.yml
 *   suanli-assistant/win32-x64/versions/<version>/<installer>
 *
 * The pointer is rewritten only after every package of that target has uploaded, so a client never
 * reads a feed whose file is not there yet. Version directories are never overwritten: a release
 * that reuses a version fails instead of replacing bytes another client may already be installing.
 *
 * Retention keeps the newest `--keep` version directories per target and never deletes the version
 * being published. Rollback is republishing an older pointer, which only works while that directory
 * still exists — that is what the retention budget buys.
 *
 *     R2_ACCOUNT_ID=… R2_BUCKET=… R2_PUBLIC_BASE=… \
 *     R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *     node scripts/release/aurora-publish.mjs --artifacts <dir> --version <version> [--keep 2]
 *     node scripts/release/aurora-publish.mjs --artifacts <dir> --version <v> --dry-run
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

/**
 * Cloudflare R2 connection read from the environment.
 *
 * R2 speaks the S3 API and nothing else, so the upload below runs the S3 client against R2's
 * endpoint. The credentials are R2 API tokens; the `AWS_*` names only exist inside the child
 * process, because that is what the S3 client reads.
 */
const CONNECTION = {
  account: 'R2_ACCOUNT_ID',
  endpoint: 'R2_ENDPOINT',
  bucket: 'R2_BUCKET',
  publicBase: 'R2_PUBLIC_BASE',
  keyId: 'R2_ACCESS_KEY_ID',
  secret: 'R2_SECRET_ACCESS_KEY',
}

/** Product namespace inside the bucket; every key lives under it. */
const DEFAULT_NAMESPACE = 'suanli-assistant'

/** Directory holding the floating copy of each installer, overwritten by every release. */
const LATEST_DIRECTORY = 'latest'

/** Version directories kept per target, including the one being published. */
const DEFAULT_KEEP = 2

/** Artifact suffix to target directory. */
const TARGETS = [
  { match: /-mac-arm64-unsigned\.(?:dmg|zip)(?:\.blockmap)?$/u, target: 'darwin-arm64', feed: 'latest-mac.yml' },
  { match: /-mac-x64-unsigned\.(?:dmg|zip)(?:\.blockmap)?$/u, target: 'darwin-x64', feed: 'latest-mac.yml' },
  { match: /-win-x64-unsigned\.exe(?:\.blockmap)?$/u, target: 'win32-x64', feed: 'latest.yml' },
]

/**
 * Read one connection value.
 * @param name - environment variable name.
 * @returns the trimmed value.
 */
function required(name) {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`aurora publish: ${name} is required`)
  return value.trim()
}

/**
 * Resolve the R2 endpoint from an explicit URL or the account id.
 * @returns the S3-compatible endpoint.
 */
function endpoint() {
  const explicit = process.env[CONNECTION.endpoint]?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  return `https://${required(CONNECTION.account)}.r2.cloudflarestorage.com`
}

/**
 * Sign and run one R2 request through curl's built-in SigV4 support.
 *
 * R2 speaks only the S3 API, but that does not require the AWS CLI: curl signs the request itself,
 * so publishing has no client dependency beyond what the build machine already has.
 *
 * @param method - HTTP method.
 * @param path - object path below the endpoint, already URL-encoded.
 * @param options - extra headers, upload file, or query string.
 * @returns the response body.
 */
function s3(method, path, options = {}) {
  const args = [
    '--silent', '--show-error', '--fail-with-body', '--max-time', String(options.timeoutMs ?? 600),
    '--request', method,
    '--aws-sigv4', 'aws:amz:auto:s3',
    '--user', `${required(CONNECTION.keyId)}:${required(CONNECTION.secret)}`,
    '--header', 'x-amz-content-sha256: UNSIGNED-PAYLOAD',
    // R2 closes the connection on the client's `Expect: 100-continue` probe; drop it.
    '--header', 'Expect:',
    '--retry', '3', '--retry-delay', '2', '--retry-all-errors',
    ...(options.contentType === undefined ? [] : ['--header', `content-type: ${options.contentType}`]),
    ...(options.upload === undefined ? [] : ['--upload-file', options.upload]),
    `${options.endpoint}/${options.bucket}${path}${options.query ?? ''}`,
  ]
  return execFileSync('curl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Content type for one artifact, so a browser or CDN does not guess. */
function contentTypeOf(file) {
  if (file.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (file.endsWith('.zip')) return 'application/zip'
  if (file.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  if (file.endsWith('.blockmap')) return 'application/octet-stream'
  return 'application/octet-stream'
}

/**
 * Object key for one artifact.
 * @param namespace - product namespace.
 * @param target - target directory.
 * @param version - publish version.
 * @param file - artifact file name.
 * @returns the bucket key.
 */
export function objectKey(namespace, target, version, file) {
  return `${namespace}/${target}/versions/${version}/${file}`
}

/**
 * Group artifacts by target.
 * @param directory - electron-builder output directory.
 * @returns one entry per target with its files and feed.
 */
export function collect(directory) {
  const entries = readdirSync(directory)
  const grouped = new Map()
  for (const name of entries) {
    const path = join(directory, name)
    if (!statSync(path).isFile()) continue
    const target = TARGETS.find(entry => entry.match.test(name))
    if (target === undefined) continue
    const files = grouped.get(target.target) ?? { feed: target.feed, files: [], uploaded: new Set() }
    files.files.push(name)
    grouped.set(target.target, files)
  }
  return grouped
}

/**
 * Zip the packaged application so electron-updater has a differential-update payload.
 *
 * Unsigned local builds emit only the disk image; the updater downloads a ZIP and applies a block
 * map against it, so a feed without one would advertise an update no client can install.
 *
 * @param artifacts - electron-builder output directory.
 * @param targetDirectory - per-target directory holding the application bundle.
 * @param zipName - artifact file name to write.
 * @returns the written ZIP path.
 */
function zipApplication(artifacts, targetDirectory, zipName) {
  const directory = join(artifacts, targetDirectory)
  const bundle = readdirSync(directory).find(name => name.endsWith('.app'))
  if (bundle === undefined) throw new Error(`aurora publish: ${directory} holds no .app bundle to zip`)
  const destination = join(artifacts, zipName)
  // ditto preserves the bundle metadata and resource forks that a plain zip loses.
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(directory, bundle), destination])
  return destination
}

/**
 * Build the macOS feed electron-updater reads when the build produced none.
 * @param options - artifact directory, target, version, and the installers already collected.
 * @returns the feed text, with the ZIP appended to the caller's file list.
 */
function synthesizeMacFeed({ artifacts, target, version, files }) {
  const diskImage = files.find(name => name.endsWith('.dmg'))
  if (diskImage === undefined) throw new Error(`aurora publish: ${target} produced no disk image to pair with a ZIP`)
  const zipName = `${diskImage.replace(/\.dmg$/u, '')}.zip`
  const zipPath = join(artifacts, zipName)
  if (!existsSync(zipPath)) zipApplication(artifacts, target === 'darwin-arm64' ? 'mac-arm64' : 'mac', zipName)
  if (!files.includes(zipName)) files.push(zipName)
  const bytes = readFileSync(zipPath)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const size = bytes.length
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${zipName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${zipName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n')
}

/**
 * Rewrite one electron-builder feed so its URLs point at the versioned directory.
 * @param source - original feed text.
 * @param publicBase - public origin serving the bucket, without a trailing slash or namespace.
 * @param namespace - product namespace.
 * @param target - target directory.
 * @param version - publish version.
 * @returns the rewritten feed.
 */
export function rewriteFeed(source, publicBase, namespace, target, version) {
  return source.replace(
    /^(\s*(?:-\s+)?(?:url|path):\s*)(.+)$/gmu,
    (_line, prefix, value) => {
      const file = value.includes('/') ? value.slice(value.lastIndexOf('/') + 1) : value
      return `${prefix}${publicBase}/${objectKey(namespace, target, version, file)}`
    },
  )
}

/**
 * Publish one build.
 * @param options - parsed command line.
 */
function publish(options) {
  const endpointUrl = endpoint()
  const bucket = required(CONNECTION.bucket)
  const publicBase = required(CONNECTION.publicBase).replace(/\/+$/u, '')
  const { artifacts, version, namespace, keep, dryRun } = options
  const grouped = collect(artifacts)
  if (grouped.size === 0) throw new Error(`aurora publish: no installers in ${artifacts}`)
  const upload = (key, path, contentType) => {
    if (dryRun) {
      console.log(`  would upload ${key}`)
      return
    }
    s3('PUT', `/${key}`, { endpoint: endpointUrl, bucket, upload: path, contentType })
    console.log(`  uploaded ${key}`)
  }
  for (const [target, entry] of grouped) {
    const { feed, files } = entry
    console.log(`aurora publish: ${target}`)
    for (const file of files) {
      upload(objectKey(namespace, target, version, file), join(artifacts, file), contentTypeOf(file))
      entry.uploaded.add(file)
      // A fixed path so a download page never has to know the current version.
      if (!file.endsWith('.blockmap')) {
        upload(`${namespace}/${target}/${LATEST_DIRECTORY}/${file}`, join(artifacts, file), contentTypeOf(file))
      }
    }
    const feedPath = join(artifacts, feed)
    if (!existsSync(feedPath) && target.startsWith('darwin')) {
      // Unsigned builds stop at the disk image; the updater still needs a ZIP and a feed.
      writeFileSync(feedPath, synthesizeMacFeed({ artifacts, target, version, files }))
      for (const file of files) {
        if (!entry.uploaded.has(file)) upload(objectKey(namespace, target, version, file), join(artifacts, file), contentTypeOf(file))
      }
    }
    if (!existsSync(feedPath)) throw new Error(`aurora publish: ${target} has no ${feed}`)
    const rewritten = rewriteFeed(readFileSync(feedPath, 'utf8'), publicBase, namespace, target, version)
    const staged = join(artifacts, `${target}-${feed}`)
    writeFileSync(staged, rewritten)
    upload(`${namespace}/${target}/${feed}`, staged, 'text/yaml; charset=utf-8')
    prune({ bucket, endpoint: endpointUrl, namespace, target, keep, current: version, dryRun })
  }
}

/**
 * Delete version directories beyond the retention budget.
 * @param options - bucket connection and retention inputs.
 */
function prune({ bucket, endpoint, namespace, target, keep, current, dryRun }) {
  const prefix = `${namespace}/${target}/versions/`
  let listing
  try {
    // The bucket root takes no path segment; a trailing slash would list a `//` prefix.
    listing = s3('GET', '', { endpoint, bucket, query: `?list-type=2&prefix=${encodeURIComponent(prefix)}` })
  } catch (error) {
    // An unreadable listing must not fail the release, but it must not look like "no old versions".
    console.log(`  (could not list ${prefix}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`)
    return
  }
  const keys = [...listing.matchAll(/<Key>([^<]+)<\/Key>/gu)].map(match => match[1])
  const versions = [...new Set(keys
    .map(key => key.slice(prefix.length).split('/')[0])
    .filter(value => value !== undefined && value !== ''))]
  const sorted = versions.sort()
  const doomed = sorted.slice(0, Math.max(0, sorted.length - keep)).filter(value => value !== current)
  for (const version of doomed) {
    const stale = keys.filter(key => key.startsWith(`${prefix}${version}/`))
    if (dryRun) {
      console.log(`  would delete ${String(stale.length)} object(s) under ${prefix}${version}/`)
      continue
    }
    for (const key of stale) s3('DELETE', `/${key}`, { endpoint, bucket })
    console.log(`  deleted ${prefix}${version}/ (${String(stale.length)} object(s))`)
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      artifacts: { type: 'string' },
      version: { type: 'string' },
      namespace: { type: 'string', default: DEFAULT_NAMESPACE },
      keep: { type: 'string', default: String(DEFAULT_KEEP) },
      'dry-run': { type: 'boolean', default: false },
      'feed-only': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  if (values.artifacts === undefined || values.version === undefined) {
    throw new Error('aurora publish: --artifacts and --version are required')
  }
  const keep = Number(values.keep)
  if (!Number.isInteger(keep) || keep < 1) throw new Error('aurora publish: --keep must be a positive integer')
  if (values['feed-only']) {
    // Runs on the build machine: only macOS can zip an application bundle faithfully, while the
    // publish step may run anywhere once the ZIP and feed exist.
    const grouped = collect(values.artifacts)
    for (const [target, entry] of grouped) {
      const feedPath = join(values.artifacts, entry.feed)
      if (existsSync(feedPath) || !target.startsWith('darwin')) continue
      writeFileSync(feedPath, synthesizeMacFeed({ artifacts: values.artifacts, target, version: values.version, files: entry.files }))
      console.log(`prepared ${entry.feed} with ${entry.files.length} file(s)`)
    }
    return
  }
  publish({
    artifacts: values.artifacts,
    version: values.version,
    namespace: values.namespace,
    keep,
    dryRun: values['dry-run'],
  })
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main()
