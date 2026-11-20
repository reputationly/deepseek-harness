/**
 * Gaze frames of version 2 spritesheets. The pet window ignores the mouse, so the shell computes the cursor offset.
 * Adapted from MichengAI/dsh-codex-desktop (Apache-2.0).
 */

/** The last two rows hold 16 clockwise gaze directions starting from straight up; the dead zone matches the plugin. */
export function lookCell(
  dx: number,
  dy: number,
): { row: number; col: number } | null {
  if (Math.hypot(dx, dy) < 28) return null
  const index =
    Math.round(
      ((Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 8),
    ) % 16
  return { row: 9 + Math.floor(index / 8), col: index % 8 }
}

/** Offsets of the sprite inside its window; pet-window-html positions `.pet` with the same values. */
export const PET_SPRITE_RIGHT = 12
export const PET_SPRITE_BOTTOM = 30

/** Cursor offset from the sprite center; window bounds and the cursor point are both in DIP. */
export function gazeDelta(
  cursor: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
  size: number,
): { dx: number; dy: number } {
  const height = (size * 208) / 192
  const centerX = bounds.x + bounds.width - PET_SPRITE_RIGHT - size / 2
  const centerY = bounds.y + bounds.height - PET_SPRITE_BOTTOM - height / 2
  return { dx: cursor.x - centerX, dy: cursor.y - centerY }
}

export function gazePayload(
  state: { pet: { version: number }; activity: { pose: string }; config: { size: number } } | null,
  cursor: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): { dx: number; dy: number } | null {
  if (!state || state.pet.version !== 2 || state.activity.pose !== 'idle') return null
  return gazeDelta(cursor, bounds, state.config.size)
}

/**
 * Spritesheet pixel under a point of the displayed sprite, or null outside the cell. Cells are 192×208 source pixels
 * and the sprite is `size` wide, so the pet window can ignore clicks on the transparent part of the current frame.
 */
export function spritePixel(
  offsetX: number,
  offsetY: number,
  size: number,
  cell: { row: number; col: number },
): { x: number; y: number } | null {
  const x = Math.floor((offsetX / size) * 192)
  const y = Math.floor((offsetY / size) * 192)
  if (!(x >= 0 && x < 192 && y >= 0 && y < 208)) return null
  return { x: cell.col * 192 + x, y: cell.row * 208 + y }
}
