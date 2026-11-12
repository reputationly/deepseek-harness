/** Where the inspector sits in the studio, given the room the canvas has. */

/** Width the studio needs before the inspector may take a column of its own. */
export const INSPECTOR_MIN_WIDTH = 960

/** How the studio shows the inspector. */
export type InspectorPlacement = 'sidebar' | 'drawer'

/**
 * Placement for one studio width.
 * @param width - width of the canvas area inside the studio.
 * @param minWidth - width below which the inspector must overlay instead of take a column.
 * @returns `sidebar` when the canvas can keep its minimum with the inspector beside it.
 */
export function inspectorPlacement(width: number, minWidth = INSPECTOR_MIN_WIDTH): InspectorPlacement {
  return width >= minWidth ? 'sidebar' : 'drawer'
}
