/** The role menu a dropped connection opens, rendered from the gesture hook's pending request. */
import type { ReactNode } from 'react'
import type { CanvasDocument, CanvasEdgeRole } from '@deepseek-ai/dsh-canvas/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { RoleMenu } from './RoleMenu.tsx'
import { roleMenu } from './model/edges.ts'
import type { PendingMenu } from './useGestures.ts'
import type { NS } from './locales.ts'

/** Inputs of the connection role menu. */
export interface CanvasRoleMenuProps {
  readonly document: CanvasDocument
  readonly menu: PendingMenu | undefined
  readonly onPick: (menu: PendingMenu, role: CanvasEdgeRole) => void
  readonly onClose: () => void
  readonly t: PropsLocale<typeof NS>['t']
}

/**
 * Role menu of one pending connection.
 * @param props - document, pending request, and the pick and close calls.
 * @returns the menu, or nothing while no connection waits for a role.
 */
export function CanvasRoleMenu({ document, menu, onPick, onClose, t }: CanvasRoleMenuProps): ReactNode {
  if (menu === undefined) return undefined
  const taken = document.edges
    .filter(edge => edge.source === menu.source && edge.target === menu.target)
    .flatMap(edge => edge.role === undefined ? [] : [edge.role])
  const source = document.nodes.find(node => node.id === menu.source)?.type ?? 'text'
  const target = document.nodes.find(node => node.id === menu.target)?.type ?? 'text'
  return <RoleMenu
    x={menu.x} y={menu.y} choices={roleMenu(source, target, taken)}
    onPick={(role) => { onPick(menu, role) }} onClose={onClose} t={t}
  />
}
