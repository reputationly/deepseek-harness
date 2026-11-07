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
