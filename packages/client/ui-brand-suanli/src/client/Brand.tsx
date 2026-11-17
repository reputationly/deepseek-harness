import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import markUrl from './assets/suanli-mark.png'
import { ConnectionPill, type GatewayStatusFace } from './ConnectionPill.tsx'
import css from './Brand.module.css'

/** Product name shown in the sidebar; release builds supply it through `DSH_CLIENT_TITLE`. */
const PRODUCT_NAME = process.env.DSH_CLIENT_TITLE ?? 'Aurora'

/**
 * Render this fork's mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation; the blank home also passes its geometry class.
 * @returns the brand mark.
 */
export function BrandMark({ size, className }: SidebarBrandMarkOwnerProps & { className?: string | undefined }) {
  return <img src={markUrl} width={size} height={size} alt="" aria-hidden="true" className={className} draggable={false} />
}

/** Render inputs for the wordmark row: the Host gateway namespace and the plugin dictionary. */
export type BrandNameProps = PropsLocale<'gatewayStatus'> & GatewayStatusFace

/**
 * Render the product name followed by the gateway connection light.
 * @param props - connection operations and the locale seat.
 * @returns the sidebar wordmark row.
 */
export function BrandName({ read, refresh, t }: BrandNameProps) {
  return <span className={css.row}>
    <span className={css.name}>{PRODUCT_NAME}</span>
    <ConnectionPill read={read} refresh={refresh} t={t} />
  </span>
}
