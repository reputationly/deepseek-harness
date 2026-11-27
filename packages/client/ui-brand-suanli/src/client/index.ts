/** The product wordmark row, the sidebar brand slots, and the blank-home mark. */

import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelsFooterOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-gateway-status/remote'
import type {} from '@deepseek-ai/dsh-suanli-model-catalog/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GatewayStatus } from '@deepseek-ai/dsh-api-gateway-status/types'
import { BrandMark, BrandName } from './Brand.tsx'
import type { GatewayStatusFace } from './ConnectionPill.tsx'
import { CatalogSyncRow, type CatalogSyncOutcome } from './CatalogSyncRow.tsx'
import { GenerateImageCard, type GenerateImageCardInjected, type OpenInCreative } from './GenerateImageCard.tsx'
import { GenerateMediaCard, type MediaLoader } from './GenerateMediaCard.tsx'
import { ModelRolesRow, type ModelRoleView, type ModelRolesView } from './ModelRolesRow.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type GatewayStatusKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Connection state copy shown beside the wordmark. */
    gatewayStatus: GatewayStatusKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'gatewayStatus'

/** Services this plugin uses: the slots and their dictionary. The Host gateway namespace is optional. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Fill the sidebar and blank-home brand slots with this product's artwork.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh, ja, es, fr, de, ru, pt }), 'brand: connection dictionaries')
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, BrandMark))
  // The model catalog the picker offers comes from this deployment's gateway; a deployment
  // that mounts no catalog row keeps the pinned list, and the button reports instead.
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'model-catalog-sync', order: 50, locale: NS,
    inject: () => ({
      refresh: async (): Promise<CatalogSyncOutcome> => await refreshCatalog(catalogService(ctx)),
    }),
  }, (props: ModelsFooterOwnerProps & { refresh: () => Promise<CatalogSyncOutcome>; t: TranslateNS<'gatewayStatus'> }) =>
    createElement(CatalogSyncRow, { refresh: props.refresh, t: props.t })))
  // One gateway key calls every role; the user only picks which catalog model fills each one.
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'model-roles', order: 40, locale: NS,
    inject: () => ({
      load: async (): Promise<ModelRolesView> => await readRoles(catalogService(ctx)),
      select: async (role: ModelRoleView['role'], model: string | null): Promise<ModelRolesView> => {
        const remote = catalogService(ctx)
        valueOf(await remote.selectRole(role, model))
        return await readRoles(remote)
      },
      setAutoReview: async (enabled: boolean): Promise<ModelRolesView> => {
        const remote = catalogService(ctx)
        valueOf(await remote.setAutoReview(enabled))
        return await readRoles(remote)
      },
    }),
  }, (props: ModelsFooterOwnerProps & {
    load: () => Promise<ModelRolesView>
    select: (role: ModelRoleView['role'], model: string | null) => Promise<ModelRolesView>
    setAutoReview: (enabled: boolean) => Promise<ModelRolesView>
    t: TranslateNS<'gatewayStatus'>
  }) => createElement(ModelRolesRow, { load: props.load, select: props.select, setAutoReview: props.setAutoReview, t: props.t })))
  // Images generated from chat render inline, with download, prompt copy, and regenerate.
  // 「拿去精修」 hands the images to the creative workbench's image-to-image page while that workbench is on.
  const creative = (): CreativeFace | undefined => ctx.get('suanliCreative') as CreativeFace | undefined
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'generate_image', locale: NS,
    inject: (): GenerateImageCardInjected => ({
      hooks: {
        creativeReady: {
          getSnapshot: () => creative()?.ready?.getSnapshot() ?? false,
          subscribe: listener => creative()?.ready?.subscribe(listener) ?? (() => {}),
        },
      },
      openInCreative: input => creative()?.openImages(input) ?? false,
    }),
  }, GenerateImageCard))
  // Videos and music play inline once the user asks; the bytes come from the call's own Session workspace.
  for (const key of ['generate_video', 'generate_music', 'generate_speech']) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key, locale: NS,
      inject: (sessionId: SessionId): { loadMedia: MediaLoader } => ({
        loadMedia: async (path, mediaType, signal) => await readWhole(ctx, sessionId, path, mediaType, signal),
      }),
    }, GenerateMediaCard))
  }
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark)
      yield ctx.slots.register({
        name: 'sidebar.brand.name',
        locale: NS,
        inject: (): GatewayStatusFace => ({
          // A refused call leaves the light where it was; the next poll asks again. A deployment
          // without the gateway-status row renders the light as not connected.
          read: async () => unwrap(await gatewayStatus(ctx).read()),
          refresh: async () => unwrap(await gatewayStatus(ctx).refresh()),
        }),
      }, BrandName)
    }))
}

/**
 * Refresh the catalog and flatten the transport envelope for the row.
 * @param remote - Host catalog namespace.
 * @returns the outcome the row renders.
 * @throws When the Host reported a transport failure.
 */
async function refreshCatalog(
  remote: ClientContext['remote']['suanliModels'],
): Promise<CatalogSyncOutcome> {
  const answer = await remote.refresh()
  if (!answer.ok) throw new Error(answer.error.message)
  const value = answer.value
  return value.ok
    ? { ok: true, count: value.count, changed: value.changed, classes: value.classes }
    : { ok: false, reason: value.reason }
}

/**
 * Unwrap one Host answer.
 * @param answer - the transport envelope.
 * @returns the value.
 * @throws When the Host reported a failure.
 */
function valueOf<T>(
  answer: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } },
): T {
  if (!answer.ok) throw new Error(answer.error.message)
  return answer.value
}

/**
 * Read the roles and preferences the role rows render.
 * @param remote - Host catalog namespace.
 * @returns the roles with the review preference.
 * @throws When the Host reported a failure.
 */
async function readRoles(remote: ClientContext['remote']['suanliModels']): Promise<ModelRolesView> {
  const [roles, preferences] = await Promise.all([remote.roles(), remote.preferences()])
  return { roles: valueOf(roles), autoReview: valueOf(preferences).autoReview }
}

/**
 * Reach the Host catalog namespace, which only a deployment with a gateway mounts.
 * @param ctx - Client root context.
 * @returns the namespace handle.
 * @throws When this deployment mounts no catalog row.
 */
/** The part of the creative workbench's Client service the image card calls. */
interface CreativeFace {
  openImages: OpenInCreative
  /** Absent on workbench releases before the image-to-image hand-off. */
  ready?: { getSnapshot: () => boolean; subscribe: (listener: () => void) => () => void }
}

function catalogService(ctx: ClientContext): ClientContext['remote']['suanliModels'] {
  const remote = ctx.get('remote.suanliModels') as ClientContext['remote']['suanliModels'] | undefined
  if (remote === undefined) throw new Error('the model catalog service is not mounted')
  return remote
}

/**
 * Reach the Host gateway namespace, which only a deployment with a gateway mounts.
 * @param ctx - Client root context.
 * @returns the namespace handle.
 * @throws When this deployment mounts no gateway-status row.
 */
function gatewayStatus(ctx: ClientContext): ClientContext['remote']['gatewayStatus'] {
  // The namespace is absent where the deployment mounts no gateway-status row.
  const remote = ctx.get('remote.gatewayStatus') as ClientContext['remote']['gatewayStatus'] | undefined
  if (remote === undefined) throw new Error('gateway status is not mounted')
  return remote
}

/**
 * @param result - one Remote answer.
 * @returns the observation, or a rejected call so the caller keeps its last one.
 */
function unwrap(result: { ok: true; value: GatewayStatus } | { ok: false; error: unknown }): GatewayStatus {
  if (!result.ok) throw new Error('gateway status request failed')
  return result.value
}

/** Upper bound on one generated file the card reads into memory. */
const MAX_MEDIA_BYTES = 512 * 1024 * 1024
/** Binary-RPC responses stay small enough for the desktop multipart carrier. */
const MEDIA_CHUNK_BYTES = 256 * 1024

/**
 * Read one workspace file window by window, so files above the full-read cap still play.
 * @param ctx - Client root context.
 * @param sessionId - Session whose workspace holds the file.
 * @param path - saved file path.
 * @param mediaType - the type the Blob carries.
 * @param signal - aborts the read.
 * @returns the file's bytes.
 * @throws When the Host refuses a window or the file exceeds the bound.
 */
async function readWhole(ctx: ClientContext, sessionId: SessionId, path: string, mediaType: string, signal: AbortSignal): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (;;) {
    let answer = await ctx.remote.workspaceFiles.readBytes(sessionId, path, { range: { offset, length: MEDIA_CHUNK_BYTES } }, signal)
    if (!answer.ok && offset === 0) answer = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
    if (!answer.ok) throw new Error(answer.error.message)
    const data = new Uint8Array(answer.value.data.byteLength)
    data.set(answer.value.data)
    parts.push(data)
    offset += data.byteLength
    if (answer.value.eof || data.byteLength === 0) return new Blob(parts, { type: mediaType })
    if (offset > MAX_MEDIA_BYTES) throw new Error(`"${path}" exceeds ${String(MAX_MEDIA_BYTES)} bytes`)
  }
}
