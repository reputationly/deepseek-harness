/** The small menu that asks which role a connection carries when more than one fits. */
import { useEffect, type ReactNode } from 'react'
import type { CanvasEdgeRole } from '@deepseek-ai/dsh-canvas/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { roleMenu, type RoleChoice } from './model/edges.ts'
import type { NS } from './locales.ts'
import css from './RoleMenu.module.css'

/** Where the menu appears and which roles the pair offers. */
export interface RoleMenuProps {
  readonly x: number
  readonly y: number
  readonly choices: readonly RoleChoice[]
  readonly onPick: (role: CanvasEdgeRole) => void
  readonly onClose: () => void
  readonly t: PropsLocale<typeof NS>['t']
}

/**
 * Role choice menu.
 * @param props - position, choices, and the pick and close calls.
 * @returns the menu.
 */
export function RoleMenu({ x, y, choices, onPick, onClose, t }: RoleMenuProps): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])
  return <>
    <div className={css.backdrop} onClick={onClose} role="presentation" />
    <div className={css.menu} style={{ left: x, top: y }} role="menu">
      {choices.map(choice => <button
        key={choice.role}
        type="button"
        role="menuitem"
        className={css.item}
        disabled={choice.taken}
        onClick={() => { onPick(choice.role) }}
      >{t(choice.labelKey, { n: 1 })}{choice.taken ? ` · ${t('edge.taken')}` : ''}</button>)}
    </div>
  </>
}

/** Build the choices for one pair, for callers that do not import the model. */
export { roleMenu }
