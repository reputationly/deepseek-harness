import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'
import { parse } from 'yaml'

/** Product gateway baked into the shell at build time, and the profile patch that activates it. */

/** One model the product gateway serves. */
export interface BrandGatewayModel {
  readonly id: string
  readonly contextWindow?: number
  /** Accepted input kinds, such as text and image; the provider default (text only) when omitted. */
  readonly inputModalities?: readonly string[]
}

/** Endpoint, credential reference, and pinned catalog for the product's model gateway. */
export interface BrandGateway {
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly defaultModel: string
  /** Reasoning effort of the default selection; the provider default when omitted. */
  readonly defaultReasoningEffort?: string
  readonly models: readonly BrandGatewayModel[]
}

/** Default model selection a user saved over the brand default. */
export interface SavedSelection {
  readonly model: string
  readonly reasoningEffort?: string
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
  const { baseURL, apiKeyEnv, defaultModel, defaultReasoningEffort, models } = parsed
  if (typeof baseURL !== 'string' || !URL.canParse(baseURL)) throw new Error('desktop brand: gateway baseURL must be a URL')
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv === '') throw new Error('desktop brand: gateway apiKeyEnv must be a credential reference')
  if (typeof defaultModel !== 'string' || defaultModel === '') throw new Error('desktop brand: gateway defaultModel must be non-empty')
  if (defaultReasoningEffort !== undefined && (typeof defaultReasoningEffort !== 'string' || defaultReasoningEffort === '')) {
    throw new Error('desktop brand: gateway defaultReasoningEffort must be a non-empty string')
  }
  if (!Array.isArray(models) || models.length === 0) throw new Error('desktop brand: gateway models must be a non-empty array')
  const catalog = models.map((model: unknown) => {
    if (!record(model) || typeof model.id !== 'string' || model.id === '') {
      throw new Error('desktop brand: every gateway model needs an id')
    }
    const { contextWindow } = model
    if (contextWindow !== undefined && (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0)) {
      throw new Error(`desktop brand: gateway model ${model.id} contextWindow must be a positive integer`)
    }
    const { inputModalities } = model
    if (inputModalities !== undefined && (!Array.isArray(inputModalities) || inputModalities.length === 0
      || !inputModalities.every((kind: unknown) => typeof kind === 'string' && kind !== ''))) {
      throw new Error(`desktop brand: gateway model ${model.id} inputModalities must be a non-empty string list`)
    }
    return {
      id: model.id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...inputModalities === undefined ? {} : { inputModalities: inputModalities as string[] },
    }
  })
  if (!catalog.some(model => model.id === defaultModel)) {
    throw new Error('desktop brand: gateway defaultModel must appear in the catalog')
  }
  return { baseURL, apiKeyEnv, defaultModel, ...defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }, models: catalog }
}

/**
 * Token page of the gateway's console, where users create API keys.
 * @param gateway - configuration inlined by the build.
 * @returns the absolute console URL on the gateway's origin.
 */
export function gatewayTokenURL(gateway: BrandGateway): string {
  return new URL('/console/token', gateway.baseURL).toString()
}

/**
 * Read the default selection a previous run saved into the profile patch.
 * @param gateway - configuration inlined by the build.
 * @param patchText - current profile patch document.
 * @returns the saved model and effort when they still name a catalog model, otherwise undefined.
 */
export function savedSelection(gateway: BrandGateway, patchText: string): SavedSelection | undefined {
  let rows: unknown
  try { rows = parse(patchText) } catch { return undefined }
  if (!Array.isArray(rows)) return undefined
  const row: unknown = rows.find((entry: unknown) => record(entry) && entry.id === 'agent-default-model')
  const config = record(row) && record(row.config) ? row.config : undefined
  if (config === undefined || config.provider !== 'deepseek-official' || typeof config.model !== 'string') return undefined
  const model = config.model
  if (!gateway.models.some(entry => entry.id === model)) return undefined
  return typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
    ? { model, reasoningEffort: config.reasoningEffort }
    : { model }
}

/** Quote one YAML scalar from the build-owned configuration. */
function scalar(value: string): string {
  return JSON.stringify(value)
}

/**
 * Build the profile patch that points the bundled runtime at the product gateway.
 * @param gateway - configuration inlined by the build.
 * @param productName - provider name shown in model menus and settings; the provider's own default when omitted.
 * @param saved - default selection the user saved, kept over the brand default.
 * @returns YAML patch entries replacing the provider endpoint, catalog, and default model.
 */
export function gatewayProfilePatch(gateway: BrandGateway, productName?: string, saved?: SavedSelection): string {
  const model = saved?.model ?? gateway.defaultModel
  const reasoningEffort = saved === undefined ? gateway.defaultReasoningEffort : saved.reasoningEffort
  const models = gateway.models
    .map(model => [
      `      - id: ${scalar(model.id)}`,
      ...model.contextWindow === undefined ? [] : [`        contextWindow: ${String(model.contextWindow)}`],
      ...model.inputModalities === undefined ? [] : [`        inputModalities: [${model.inputModalities.map(scalar).join(', ')}]`],
    ].join('\n'))
    .join('\n')
  return [
    '# Written by the desktop shell at every start from its baked brand configuration.',
    '# Manual edits are replaced; use a plugin for deployment-specific changes.',
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    `    model: ${scalar(model)}`,
    ...reasoningEffort === undefined ? [] : [`    reasoningEffort: ${scalar(reasoningEffort)}`],
    '',
    '- id: llm-deepseek',
    '  config:',
    `    baseURL: ${scalar(gateway.baseURL)}`,
    `    apiKeyEnv: ${scalar(gateway.apiKeyEnv)}`,
    ...productName === undefined || productName === '' ? [] : [`    displayName: ${scalar(productName)}`],
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
    '# The footer connection light probes this same endpoint with the stored key. The row',
    '# exists only where a gateway is configured, so no bundle ships it disabled.',
    '- insert:',
    '    - id: gateway-status',
    "      name: '@deepseek-ai/dsh-api-gateway-status'",
    '      config:',
    `        baseURL: ${scalar(gateway.baseURL)}`,
    `        apiKeyEnv: ${scalar(gateway.apiKeyEnv)}`,
    '',
  ].join('\n')
}

/**
 * Replace the profile's patch layer with the baked gateway configuration, keeping the default
 * model selection the user saved from settings.
 * @param profileDir - Desktop profile directory created before the Host starts.
 */
export function writeGatewayProfile(profileDir: string): void {
  const gateway = brandGateway()
  if (gateway === undefined) return
  const path = join(profileDir, 'cordis.patch.yml')
  let previous = ''
  try { previous = readFileSync(path, 'utf8') } catch { /* first start */ }
  const patch = gatewayProfilePatch(gateway, process.env.DSH_DESKTOP_PRODUCT_NAME, savedSelection(gateway, previous))
  writeFileSync(path, patch, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Read the gateway key a previous run stored, with the credentials service's precedence: the managed document, then the environment.
 * @param gateway - configuration inlined by the build.
 * @param environment - main-process environment whose DSH_HOME names the product's Harness root.
 * @returns the stored key, or undefined when none is stored or the document cannot be read.
 */
export function storedGatewayKey(gateway: BrandGateway, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = environment[DSH_HOME_ENV]
  if (home !== undefined && home !== '') {
    try {
      const document: unknown = parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))
      const value = record(document) && record(document.refs) ? document.refs[gateway.apiKeyEnv] : undefined
      if (typeof value === 'string' && value !== '') return value
    } catch {
      // A missing or unreadable document is an absent key; parser messages may quote the secret, so none is reported.
    }
  }
  const inherited = environment[gateway.apiKeyEnv]
  return inherited === undefined || inherited === '' ? undefined : inherited
}
