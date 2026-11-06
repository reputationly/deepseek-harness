import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

/** Product name shown in the sidebar; release builds supply it through `DSH_CLIENT_TITLE`. */
const PRODUCT_NAME = process.env.DSH_CLIENT_TITLE ?? 'Aurora'

/**
 * Render this fork's mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the brand mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.5 21 7.25v9.5L12 21.5 3 16.75v-9.5z" fill="currentColor" opacity="0.16" />
      <path d="M12 5.9 17.6 16.9h-3.5l-2.1-4.4-2.1 4.4H6.4z" fill="currentColor" />
    </svg>
  )
}

/**
 * Render the product name without its independently slotted mark.
 * @returns the sidebar wordmark.
 */
export function OfficialBrandName() {
  return <span className={css.name}>{PRODUCT_NAME}</span>
}
