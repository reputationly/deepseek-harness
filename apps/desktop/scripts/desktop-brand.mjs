/** Product identity shared by the client bundle, the Electron shell, and the packaging scripts. */

import { readFileSync } from 'node:fs'

/** Brand values declared once at the repository root. */
const BRAND = JSON.parse(readFileSync(new URL('../../../brand.json', import.meta.url), 'utf8'))

/** Product name used for the application bundle, executable, window title, and installer copy. */
export const PRODUCT_NAME = BRAND.productName

/** Reverse-DNS application identifier used by unsigned local builds. */
export const BUNDLE_ID = BRAND.bundleId
