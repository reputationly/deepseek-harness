import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import markUrl from './assets/suanli-mark.png'
import css from './Brand.module.css'

/** Product name shown in the sidebar; release builds supply it through `DSH_CLIENT_TITLE`. */
const PRODUCT_NAME = process.env.DSH_CLIENT_TITLE ?? 'Aurora'

/**
 * Render this fork's mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation; the blank home also passes its geometry class.
 * @returns the brand mark.
 */
export function OfficialBrandMark({ size, className }: SidebarBrandMarkOwnerProps & { className?: string | undefined }) {
  return <img src={markUrl} width={size} height={size} alt="" aria-hidden="true" className={className} draggable={false} />
}

/**
 * Render the product name without its independently slotted mark.
 * @returns the sidebar wordmark.
 */
export function OfficialBrandName() {
  return <span className={css.name}>{PRODUCT_NAME}</span>
}
