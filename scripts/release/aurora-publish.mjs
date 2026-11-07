/**
 * Publish one completed Aurora build to the installer bucket.
 *
 * Layout: every target keeps a mutable pointer beside immutable version directories.
 *
 *   aurora/darwin-arm64/latest-mac.yml                     <- pointer, rewritten per release
 *   aurora/darwin-arm64/versions/<version>/Aurora-...dmg   <- immutable, one directory per build
 *   aurora/win32-x64/latest.yml
 *   aurora/win32-x64/versions/<version>/Aurora-...exe
 *
 * The pointer is rewritten only after every package of that target has uploaded, so a client never
 * reads a feed whose file is not there yet. Version directories are never overwritten: a release
 * that reuses a version fails instead of replacing bytes another client may already be installing.
 *
 * Retention keeps the newest `--keep` version directories per target and never deletes the version
 * being published. Rollback is republishing an older pointer, which only works while that directory
 * still exists — that is what the retention budget buys.
 *
 *     node scripts/release/aurora-publish.mjs --artifacts <dir> --version <version> [--keep 2]
 *     node scripts/release/aurora-publish.mjs --artifacts <dir> --version <v> --dry-run
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

/** Environment variables the bucket connection reads. Credentials never appear in arguments. */
const CONNECTION = {
  endpoint: 'AURORA_S3_ENDPOINT',
  bucket: 'AURORA_S3_BUCKET',
  publicBase: 'AURORA_PUBLIC_BASE',
}

/** Product namespace inside the bucket; every key lives under it. */
const DEFAULT_NAMESPACE = 'aurora'

/** Version directories kept per target, including the one being published. */
const DEFAULT_KEEP = 2

/** Artifact suffix to target directory. */
const TARGETS = [
  { match: /-mac-arm64-unsigned\.(?:dmg|zip)$/u, target: 'darwin-arm64', feed: 'latest-mac.yml' },
  { match: /-mac-x64-unsigned\.(?:dmg|zip)$/u, target: 'darwin-x64', feed: 'latest-mac.yml' },
  { match: /-win-x64-unsigned\.exe$/u, target: 'win32-x64', feed: 'latest.yml' },
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
 * Run one command and return its stdout.
 * @param command - executable.
 * @param args - arguments.
 * @returns trimmed stdout.
 */
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
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
    const files = grouped.get(target.target) ?? { feed: target.feed, files: [] }
    files.files.push(name)
    grouped.set(target.target, files)
  }
  return grouped
}

/**
 * Rewrite one electron-builder feed so its URLs point at the versioned directory.
 * @param source - original feed text.
 * @param publicBase - public bucket base URL without a trailing slash.
 * @param namespace - product namespace.
 * @param target - target directory.
 * @param version - publish version.
 * @returns the rewritten feed.
 */
export function rewriteFeed(source, publicBase, namespace, target, version) {
  return source.replace(
    /^(\s*(?:url|path):\s*)(.+)$/gmu,
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
  const endpoint = required(CONNECTION.endpoint)
  const bucket = required(CONNECTION.bucket)
  const publicBase = required(CONNECTION.publicBase).replace(/\/+$/u, '')
  const { artifacts, version, namespace, keep, dryRun } = options
  const grouped = collect(artifacts)
  if (grouped.size === 0) throw new Error(`aurora publish: no installers in ${artifacts}`)
  const upload = (key, path) => {
    if (dryRun) {
      console.log(`  would upload ${key}`)
      return
    }
    run('aws', ['s3', 'cp', path, `s3://${bucket}/${key}`, '--endpoint-url', endpoint])
    console.log(`  uploaded ${key}`)
  }
  for (const [target, { feed, files }] of grouped) {
    console.log(`aurora publish: ${target}`)
    for (const file of files) upload(objectKey(namespace, target, version, file), join(artifacts, file))
    const feedPath = join(artifacts, feed)
    if (!existsSync(feedPath)) throw new Error(`aurora publish: ${target} has no ${feed}`)
    const rewritten = rewriteFeed(readFileSync(feedPath, 'utf8'), publicBase, namespace, target, version)
    const staged = join(artifacts, `${target}-${feed}`)
    writeFileSync(staged, rewritten)
    upload(`${namespace}/${target}/${feed}`, staged)
    prune({ bucket, endpoint, namespace, target, keep, current: version, dryRun })
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
    listing = run('aws', ['s3', 'ls', `s3://${bucket}/${prefix}`, '--endpoint-url', endpoint])
  } catch (_listingFailed) {
    console.log(`  (no existing versions under ${prefix})`)
    return
  }
  const versions = listing.split('\n')
    .map(line => line.trim().split(/\s+/u).pop())
    .filter(value => value !== undefined && value.startsWith(prefix))
    .map(value => value.slice(prefix.length).replace(/\/$/u, ''))
    .filter(value => value !== '')
  const sorted = [...new Set(versions)].sort()
  const doomed = sorted.slice(0, Math.max(0, sorted.length - keep)).filter(value => value !== current)
  for (const version of doomed) {
    const key = `s3://${bucket}/${prefix}${version}/`
    if (dryRun) {
      console.log(`  would delete ${prefix}${version}/`)
      continue
    }
    run('aws', ['s3', 'rm', key, '--recursive', '--endpoint-url', endpoint])
    console.log(`  deleted ${prefix}${version}/`)
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
    },
    allowPositionals: false,
  })
  if (values.artifacts === undefined || values.version === undefined) {
    throw new Error('aurora publish: --artifacts and --version are required')
  }
  const keep = Number(values.keep)
  if (!Number.isInteger(keep) || keep < 1) throw new Error('aurora publish: --keep must be a positive integer')
  publish({
    artifacts: values.artifacts,
    version: values.version,
    namespace: values.namespace,
    keep,
    dryRun: values['dry-run'],
  })
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main()
