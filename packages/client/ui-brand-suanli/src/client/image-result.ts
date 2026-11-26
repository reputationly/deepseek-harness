/** Reads the generate_image result metadata the Host tool records for this card. */
import { reviewOf, type ResultReview } from './media-result.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'

/** One generated image the card shows. */
export interface ImageResultItem {
  readonly path: string
  readonly attachment?: ImageAttachmentRef
}

/** The card's view of one settled generation. */
export interface ImageResult {
  readonly status: 'generated' | 'cancelled'
  readonly prompt: string
  readonly modelLabel: string
  readonly parameters: readonly { readonly key: string; readonly value: string }[]
  readonly images: readonly ImageResultItem[]
  readonly review?: ResultReview
}

/**
 * Narrow recorded metadata to the card's view; anything else renders as plain text.
 * @param meta - the result's presentation metadata.
 * @returns the view, or null for an unknown shape.
 */
export function imageResultOf(meta: unknown): ImageResult | null {
  if (!isRecord(meta)) return null
  const { status, prompt, modelLabel, parameters, images } = meta
  const review = reviewOf(meta.review)
  if (status !== 'generated' && status !== 'cancelled') return null
  if (typeof prompt !== 'string' || typeof modelLabel !== 'string') return null
  if (!isRecord(parameters) || !Array.isArray(images)) return null
  const pairs = Object.entries(parameters).flatMap(([key, value]) => typeof value === 'string' ? [{ key, value }] : [])
  const items = images.filter(isRecord).flatMap((item): ImageResultItem[] => {
    if (typeof item.path !== 'string') return []
    return isAttachment(item.attachment) ? [{ path: item.path, attachment: item.attachment }] : [{ path: item.path }]
  })
  return { status, prompt, modelLabel, parameters: pairs, images: items, ...review !== undefined ? { review } : {} }
}

/**
 * @param value - candidate value.
 * @returns whether it is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param value - candidate attachment reference.
 * @returns whether it carries the fields the image loader reads.
 */
function isAttachment(value: unknown): value is ImageAttachmentRef {
  return isRecord(value) && typeof value.attachmentId === 'string' && typeof value.mediaType === 'string'
    && typeof value.bytes === 'number' && typeof value.width === 'number' && typeof value.height === 'number'
}
