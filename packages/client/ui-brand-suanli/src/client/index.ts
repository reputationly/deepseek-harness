/** The product wordmark row, the sidebar brand slots, and the blank-home mark. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-gateway-status/remote'
import type { GatewayStatus } from '@deepseek-ai/dsh-api-gateway-status/types'
import { BrandMark, BrandName } from './Brand.tsx'
import type { GatewayStatusFace } from './ConnectionPill.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type GatewayStatusKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Connection state copy shown beside the wordmark. */
    gatewayStatus: GatewayStatusKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'gatewayStatus'

/** Services this plugin uses: the slots, their dictionary, and the Host gateway namespace. */
export const inject = ['slots', 'locale', 'remote', 'remote.gatewayStatus']

/**
 * Fill the sidebar and blank-home brand slots with this product's artwork.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh, ja, es, fr, de, ru, pt }), 'brand: connection dictionaries')
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, BrandMark))
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark)
      yield ctx.slots.register({
        name: 'sidebar.brand.name',
        locale: NS,
        inject: (): GatewayStatusFace => ({
          // A refused call leaves the light where it was; the next poll asks again.
          read: async () => unwrap(await ctx.remote.gatewayStatus.read()),
          refresh: async () => unwrap(await ctx.remote.gatewayStatus.refresh()),
        }),
      }, BrandName)
    }))
}

/**
 * @param result - one Remote answer.
 * @returns the observation, or a rejected call so the caller keeps its last one.
 */
function unwrap(result: { ok: true; value: GatewayStatus } | { ok: false; error: unknown }): GatewayStatus {
  if (!result.ok) throw new Error('gateway status request failed')
  return result.value
}
