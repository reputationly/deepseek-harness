/** Product name used for the application bundle, executable, window title, and installer copy. */
export declare const PRODUCT_NAME: string

/** Reverse-DNS application identifier used by unsigned local builds. */
export declare const BUNDLE_ID: string

/** One model the product gateway serves. */
export interface BrandGatewayModel {
  readonly id: string
  readonly contextWindow: number
}

/** Product model gateway configuration baked into the application. */
export interface BrandGateway {
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly defaultModel: string
  readonly models: readonly BrandGatewayModel[]
}

/** Product model gateway: endpoint, credential reference, and the catalog the shell pins. */
export declare const GATEWAY: BrandGateway

/** Directory name of the product-owned Harness home under the OS home. */
export declare const HOME_DIR_NAME: string

/** URL scheme the product registers with the operating system. */
export declare const URL_SCHEME: string

/** Packaged application manifest name; Electron derives the userData directory from it. */
export declare const PACKAGE_NAME: string

/** ASCII name shared by packaged artifact filenames, update-feed objects, and the version listing. */
export declare const ARTIFACT_BASENAME: string

/** Windows executable and macOS bundle binary file name (electron-builder `executableName`). */
export declare const EXECUTABLE_NAME: string
