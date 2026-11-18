/** API-key configuration resolved together with one Messages endpoint generation and its model listing. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  DEFAULT_MODELS_PATH, deepSeekConfigFields, isBuiltInCatalog, modelListingConfigFields, modelListingURL,
  plainOptions as protocolOptions, PUBLIC_BASE_URL, resolveAdapterOptions as resolveProtocolOptions, resolveListingTiming,
} from '@deepseek-ai/dsh-llm-deepseek'
import type {
  Config as ProtocolConfig, DeepSeekConnectionOptions, ListingSettings, ModelListingConfig, ModelListingOptions, Options as ProtocolOptions,
} from '@deepseek-ai/dsh-llm-deepseek'

/** Origin of the official API, the only endpoint whose `/models` listing this route follows. */
const OFFICIAL_ORIGIN = new URL(PUBLIC_BASE_URL).origin

/** Messages configuration with a per-request API-key reference. */
export interface Config extends ProtocolConfig, ModelListingConfig {
  /** Credential reference resolved per request; defaults to DEEPSEEK_API_KEY. */
  apiKeyEnv: Volatile<string>
  /** Provider name shown in model menus and settings; defaults to DeepSeek. */
  displayName: string
  /**
   * Path of the model listing on this endpoint (default `/models`). A gateway that serves an
   * OpenAI-compatible API under a prefix answers at `/v1/models`.
   */
  modelsPath: string
  /**
   * Follow the endpoint's listing even off the official origin. Off by default because a
   * third-party endpoint's catalog is only authoritative for its own models.
   */
  followListing: boolean
}
export const Config = z.object({
  ...deepSeekConfigFields,
  ...modelListingConfigFields,
  apiKeyEnv: z.string().role('credential-ref').default('DEEPSEEK_API_KEY').volatile(),
  displayName: z.string().min(1).default('DeepSeek'),
  modelsPath: z.string().pattern(/^\//u).default(DEFAULT_MODELS_PATH),
  followListing: z.boolean().default(false),
})
/** Plain deployment inputs for the API-key provider. */
export type Options = ProtocolOptions & ModelListingOptions & {
  apiKeyEnv?: string
  modelsPath?: string
  followListing?: boolean
}
/** Endpoint and credential reference captured from the same configuration generation. */
export interface ResolvedDeepSeekOptions extends DeepSeekConnectionOptions {
  /** Credential reference used only for this connection snapshot. */
  apiKeyEnv: CredentialRef
  /**
   * The official `/models` listing this generation follows; absent when `models`
   * differs from the built-in catalog or the endpoint is not the official API.
   */
  listing?: ListingSettings
}
/** Read one validated provider configuration.
 * @param config - live plugin configuration.
 * @returns detached resolver inputs.
 */
export function plainOptions(config: Config): Options {
  return {
    ...protocolOptions(config),
    apiKeyEnv: config.apiKeyEnv.get(),
    modelsPath: config.modelsPath,
    followListing: config.followListing,
  }
}
/** Resolve API-key, listing, and protocol settings together.
 * @param config - raw deployment settings.
 * @param environment - application launch environment.
 * @returns validated endpoint facts, the matching credential reference, and the listing the catalog follows.
 */
export function resolveAdapterOptions(config: Options, environment?: LaunchEnvironmentSnapshot): ResolvedDeepSeekOptions {
  const { modelsTimeoutMs: _timeout, modelsMaxAgeMs: _maxAge, apiKeyEnv, modelsPath, followListing, ...messages } = config
  const timing = resolveListingTiming(config, 'llm-deepseek-api-key')
  const connection = resolveProtocolOptions(messages, environment)
  const official = new URL(connection.baseURL).origin === OFFICIAL_ORIGIN && isBuiltInCatalog(connection.models)
  const listed = followListing === true || official
  return {
    ...connection,
    apiKeyEnv: credentialRef(apiKeyEnv ?? 'DEEPSEEK_API_KEY'),
    ...listed
      ? { listing: { url: modelListingURL(connection.baseURL, modelsPath), ...timing } }
      : {},
  }
}
