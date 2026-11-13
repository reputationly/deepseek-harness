/**
 * Settle generation parameters against one capability's parameter schema.
 *
 * A value the user stated and the schema accepts is used as is. A value the schema does not accept,
 * or a choosable parameter nobody stated, becomes a choice for the user instead of a guess.
 * @module
 */

import type { Capability } from './catalog.ts'

/** One parameter the user must pick before generation. */
export interface ParamChoice {
  /** Request parameter name. */
  readonly id: string
  /** Gateway-supplied label. */
  readonly title: string
  /** Accepted values, in gateway order. */
  readonly options: readonly string[]
  /** Value to recommend. */
  readonly recommended: string
  /** The stated value the schema does not accept; absent when nothing was stated. */
  readonly rejected?: string
}

/** Outcome of settling one request. */
export type Settlement =
  | { readonly kind: 'ready'; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: 'ask'; readonly choices: readonly ParamChoice[] }

/** Inputs of settleParams. */
export interface SettleOptions {
  /** Values the caller stated, keyed by schema parameter name. */
  readonly requested: Readonly<Record<string, string | undefined>>
  /** Choosable parameters that must come from the user when unstated. */
  readonly ask: readonly string[]
  /** Product defaults overriding the schema default when the schema accepts them. */
  readonly defaults?: Readonly<Record<string, string>>
  /** Parameters this request does not use. */
  readonly skip?: readonly string[]
}

/** Canonical spelling of a stated value, matched case-insensitively and without a trailing seconds unit. */
function canonical(value: string, options: readonly string[]): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s*(s|sec|secs|seconds|秒)$/u, '').replace(/：/gu, ':')
  return options.find(option => option.toLowerCase() === normalized)
}

/**
 * Settle every schema parameter for one request.
 * @param capability - capability whose schema bounds the values.
 * @param options - stated values, parameters to ask about, and product defaults.
 * @returns the complete parameter set, or the choices the user must make first.
 */
export function settleParams(capability: Capability, options: SettleOptions): Settlement {
  const params: Record<string, string> = {}
  const choices: ParamChoice[] = []
  const skip = new Set(options.skip ?? [])
  for (const [id, schema] of Object.entries(capability.paramSchema?.properties ?? {})) {
    if (skip.has(id)) continue
    const accepted = schema.enum ?? []
    const productDefault = options.defaults?.[id]
    const recommended = (productDefault !== undefined && accepted.includes(productDefault) ? productDefault : undefined)
      ?? (schema.default !== undefined && (accepted.length === 0 || accepted.includes(schema.default)) ? schema.default : undefined)
      ?? accepted[0]
    const stated = options.requested[id]
    if (stated !== undefined && stated.trim() !== '') {
      if (accepted.length === 0) {
        params[id] = stated.trim()
        continue
      }
      const hit = canonical(stated, accepted)
      if (hit !== undefined) {
        params[id] = hit
        continue
      }
      // A non-empty enumeration always yields a recommendation from its first value.
      choices.push({ id, title: schema.title ?? id, options: accepted, recommended: recommended as string, rejected: stated.trim() })
      continue
    }
    if (accepted.length > 1 && options.ask.includes(id)) {
      choices.push({ id, title: schema.title ?? id, options: accepted, recommended: recommended as string })
      continue
    }
    if (recommended !== undefined) params[id] = recommended
  }
  return choices.length > 0 ? { kind: 'ask', choices } : { kind: 'ready', params }
}
