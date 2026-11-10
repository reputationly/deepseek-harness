/** Canvas tab chip: the layers icon and the localized title. */
import type { ReactNode } from 'react'
import { IconLayersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import css from './CanvasBody.module.css'

/**
 * @param props - the enclosing tab's framework-bound reader.
 * @returns the icon followed by the tab's title.
 */
export function CanvasTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>): ReactNode {
  const { tab } = useTabInfo()
  return <><IconLayersOutlineRegular className={css.titleIcon} />{tab.title}</>
}
