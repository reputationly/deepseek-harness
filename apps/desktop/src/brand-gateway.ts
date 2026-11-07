import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Product gateway baked into the shell at build time, and the profile patch that activates it. */

/** One model the product gateway serves. */
export interface BrandGatewayModel {
  readonly id: string
  readonly contextWindow?: number
}

/** Endpoint, credential reference, and pinned catalog for the product's model gateway. */
export interface BrandGateway {
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly defaultModel: string
  readonly models: readonly BrandGatewayModel[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the gateway configuration inlined by the build.
 * @returns the validated gateway, or undefined when the build inlined none.
 */
export function brandGateway(): BrandGateway | undefined {
  const raw = process.env.DSH_BRAND_GATEWAY
  if (raw === undefined || raw === '') return undefined
  const parsed: unknown = JSON.parse(raw)
  if (!record(parsed)) throw new Error('desktop brand: gateway configuration must be an object')
  const { baseURL, apiKeyEnv, defaultModel, models } = parsed
  if (typeof baseURL !== 'string' || !URL.canParse(baseURL)) throw new Error('desktop brand: gateway baseURL must be a URL')
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv === '') throw new Error('desktop brand: gateway apiKeyEnv must be a credential reference')
  if (typeof defaultModel !== 'string' || defaultModel === '') throw new Error('desktop brand: gateway defaultModel must be non-empty')
  if (!Array.isArray(models) || models.length === 0) throw new Error('desktop brand: gateway models must be a non-empty array')
  const catalog = models.map((model: unknown) => {
    if (!record(model) || typeof model.id !== 'string' || model.id === '') {
      throw new Error('desktop brand: every gateway model needs an id')
    }
    const { contextWindow } = model
    if (contextWindow !== undefined && (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
      throw new Error(`desktop brand: gateway model ${model.id} contextWindow must be a positive integer`)
    }
    return contextWindow === undefined ? { id: model.id } : { id: model.id, contextWindow }
  })
  if (!catalog.some(model => model.id === defaultModel)) {
    throw new Error('desktop brand: gateway defaultModel must appear in the catalog')
  }
  return { baseURL, apiKeyEnv, defaultModel, models: catalog }
}

/** Quote one YAML scalar from the build-owned configuration. */
function scalar(value: string): string {
  return JSON.stringify(value)
}

/**
 * Build the profile patch that points the bundled runtime at the product gateway.
 * @param gateway - configuration inlined by the build.
 * @returns YAML patch entries replacing the provider endpoint, catalog, and default model.
 */
export function gatewayProfilePatch(gateway: BrandGateway): string {
  const models = gateway.models
    .map(model => `      - id: ${scalar(model.id)}${model.contextWindow === undefined ? '' : `\n        contextWindow: ${String(model.contextWindow)}`}`)
    .join('\n')
  return [
    '# Written by the desktop shell at every start from its baked brand configuration.',
    '# Manual edits are replaced; use a plugin for deployment-specific changes.',
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    `    model: ${scalar(gateway.defaultModel)}`,
    '',
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${scalar(gateway.baseURL)}`,
    `    apiKeyEnv: ${scalar(gateway.apiKeyEnv)}`,
    '    models:',
    models,
    '',
    '# Media tools over the same gateway; the base bundle ships this row disabled.',
    '- id: tool-media',
    '  disabled: false',
    '  config:',
    `    baseURL: ${scalar(gateway.baseURL)}`,
    `    apiKeyEnv: ${scalar(gateway.apiKeyEnv)}`,
    '',
  ].join('\n')
}

/**
 * Replace the profile's patch layer with the baked gateway configuration.
 * @param profileDir - Desktop profile directory created before the Host starts.
 */
export function writeGatewayProfile(profileDir: string): void {
  const gateway = brandGateway()
  if (gateway === undefined) return
  writeFileSync(join(profileDir, 'cordis.patch.yml'), gatewayProfilePatch(gateway), { encoding: 'utf8', mode: 0o600 })
}
