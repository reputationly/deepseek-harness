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
