/** Product identity shared by the client bundle, the Electron shell, and the packaging scripts. */

import { readFileSync } from 'node:fs'

/** Brand values declared once at the repository root. */
const BRAND = JSON.parse(readFileSync(new URL('../../../brand.json', import.meta.url), 'utf8'))

/** Product name used for the application bundle, executable, window title, and installer copy. */
export const PRODUCT_NAME = BRAND.productName

/** Reverse-DNS application identifier used by unsigned local builds. */
export const BUNDLE_ID = BRAND.bundleId

/** Product model gateway: endpoint, credential reference, and the catalog the shell pins. */
export const GATEWAY = BRAND.gateway

/** Hidden directory names start with a dot followed by a letter or digit, then letters, digits, dots, underscores, or hyphens. */
const HOME_DIR_NAME_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/u

/** URL schemes start with a lowercase letter, then lowercase letters, digits, plus, dot, or hyphen. */
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/u

if (typeof BRAND.homeDirName !== 'string' || !HOME_DIR_NAME_PATTERN.test(BRAND.homeDirName)) {
  throw new Error(`desktop brand: homeDirName must be a hidden directory name, got ${JSON.stringify(BRAND.homeDirName)}`)
}
if (BRAND.homeDirName.toLowerCase() === '.dsh') {
  throw new Error('desktop brand: homeDirName must differ from the upstream Harness home')
}
if (typeof BRAND.urlScheme !== 'string' || !URL_SCHEME_PATTERN.test(BRAND.urlScheme)) {
  throw new Error(`desktop brand: urlScheme must be a URL scheme, got ${JSON.stringify(BRAND.urlScheme)}`)
}
if (BRAND.urlScheme === 'dsh') {
  throw new Error('desktop brand: urlScheme must differ from the upstream Harness scheme')
}

/** Package names are lowercase letters, digits, and hyphens, starting with a letter or digit. */
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

if (typeof BRAND.packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(BRAND.packageName)) {
  throw new Error(`desktop brand: packageName must be a lowercase package name, got ${JSON.stringify(BRAND.packageName)}`)
}
if (BRAND.packageName === 'dsh-desktop') {
  throw new Error('desktop brand: packageName must differ from the upstream desktop package name')
}

/** Directory name of the product-owned Harness home under the OS home. */
export const HOME_DIR_NAME = BRAND.homeDirName

/** URL scheme the product registers with the operating system. */
export const URL_SCHEME = BRAND.urlScheme

/** Packaged application manifest name; Electron derives the userData directory from it. */
export const PACKAGE_NAME = BRAND.packageName

/**
 * ASCII name shared by every packaged filename: installers, updater payloads, blockmaps,
 * retained release objects, and the version listing that skips published builds. It stays
 * separate from {@link PRODUCT_NAME} because artifact names reach URLs and update feeds,
 * where only `[a-z0-9-]` is safe.
 */
export const ARTIFACT_BASENAME = BRAND.packageName

/**
 * Windows executable and macOS bundle binary file name, matching electron-builder's `executableName`.
 * Display names stay {@link PRODUCT_NAME}; only filesystem and command paths use this.
 */
export const EXECUTABLE_NAME = ARTIFACT_BASENAME
