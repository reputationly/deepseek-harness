/**
 * Compute the version one Aurora build publishes.
 *
 * The upstream DeepSeek Harness version stays the prefix so an installed build always reads as
 * "this harness release, our build of it". The suffix is the UTC build time to the minute, which
 * orders builds within one upstream release without a long identifier.
 *
 * Two builds started in the same minute therefore carry the same version; publish one build per
 * minute, or wait for the next minute before republishing.
 *
 * `electron-updater` compares feed versions with semver, so the result must stay a valid semver
 * prerelease and must sort above the bare upstream version: `0.2.2-rc.1` sorts below
 * `0.2.2-rc.1.ov.<stamp>.<commit>` because the shorter identifier list is a prefix.
 *
 *     node scripts/release/aurora-version.mjs
 *     0.2.2-rc.1.ov.202611072105
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Version of the harness release this build carries, from the root manifest. */
export function harnessVersion(root = REPOSITORY_ROOT) {
  const manifest = JSON.parse(readFileSync(new URL('package.json', `file://${root}/`), 'utf8'))
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('aurora version: the root manifest declares no version')
  }
  return manifest.version
}

/**
 * Format one publish version.
 * @param harness - upstream harness version, for example `0.2.2-rc.1`.
 * @param stamp - UTC build stamp `yyyyMMddHHmm`.
 * @returns the publish version.
 */
export function formatVersion(harness, stamp) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(harness)) throw new Error(`aurora version: ${harness} is not a semver version`)
  if (!/^\d{12}$/u.test(stamp)) throw new Error(`aurora version: ${stamp} is not a yyyyMMddHHmm stamp`)
  return `${harness}.ov.${stamp}`
}

/** UTC build stamp `yyyyMMddHHmm`. */
export function buildStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
}

/** Version this checkout would publish right now. */
export function currentVersion(root = REPOSITORY_ROOT, now = new Date()) {
  return formatVersion(harnessVersion(root), buildStamp(now))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${process.env.AURORA_VERSION ?? currentVersion()}\n`)
}
