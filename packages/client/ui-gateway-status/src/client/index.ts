/** Sidebar footer light reporting whether the model gateway answers for the stored key. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-gateway-status/remote'
import type { GatewayStatus } from '@deepseek-ai/dsh-api-gateway-status/types'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ConnectionPill, type GatewayStatusFace } from './ConnectionPill.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type GatewayStatusKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Gateway connection light copy. */
    gatewayStatus: GatewayStatusKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'gatewayStatus'

/** Services this plugin uses: the footer slot, its dictionary, and the Host namespace. */
export const inject = ['slots', 'locale', 'remote', 'remote.gatewayStatus']

/**
 * Register the footer connection light.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh, ja, es, fr, de, ru, pt }), 'gateway status: dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'gateway-status', locale: NS,
    inject: (): GatewayStatusFace => ({
      // A refused call leaves the light where it was; the next poll asks again.
      read: async () => unwrap(await ctx.remote.gatewayStatus.read()),
      refresh: async () => unwrap(await ctx.remote.gatewayStatus.refresh()),
    }),
  }, ConnectionPill))
}

/**
 * @param result - one Remote answer.
 * @returns the observation, or a rejected call so the caller can keep its last one.
 */
function unwrap(result: { ok: true; value: GatewayStatus } | { ok: false; error: unknown }): GatewayStatus {
  if (!result.ok) throw new Error('gateway status request failed')
  return result.value
}
