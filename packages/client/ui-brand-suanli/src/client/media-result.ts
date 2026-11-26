/** Reads the generate_video and generate_music result metadata the Host tools record for this card. */

/** One saved video or audio file. */
export interface MediaResultItem {
  readonly path: string
  readonly mediaType: string
}

/** The card's view of one settled video or music generation. */
export interface MediaResult {
  readonly status: 'generated' | 'cancelled'
  readonly prompt: string
  readonly modelLabel: string
  readonly parameters: readonly { readonly key: string; readonly value: string }[]
  readonly media: readonly MediaResultItem[]
}

/**
 * Narrow recorded metadata to the card's view; anything else renders as plain text.
 * @param meta - the result's presentation metadata.
 * @returns the view, or null for an unknown shape.
 */
export function mediaResultOf(meta: unknown): MediaResult | null {
  if (!isRecord(meta)) return null
  const { status, prompt, modelLabel, parameters, media } = meta
  if (status !== 'generated' && status !== 'cancelled') return null
  if (typeof prompt !== 'string' || typeof modelLabel !== 'string') return null
  if (!isRecord(parameters) || !Array.isArray(media)) return null
  const pairs = Object.entries(parameters).flatMap(([key, value]) => typeof value === 'string' ? [{ key, value }] : [])
  const items = media.filter(isRecord).flatMap((item): MediaResultItem[] => (
    typeof item.path === 'string' && typeof item.mediaType === 'string' ? [{ path: item.path, mediaType: item.mediaType }] : []
  ))
  return { status, prompt, modelLabel, parameters: pairs, media: items }
}

/**
 * @param value - candidate value.
 * @returns whether it is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
