/**
 * Shapes the chat generation tools exchange with the model and with the Client card.
 * @module @deepseek-ai/dsh-suanli-media-tools/types
 */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** One generation parameter the catalog entry declares as a closed set. */
export interface ParameterSpec {
  /** Catalog parameter key the submission sends, such as `aspect_ratio`. */
  readonly key: string
  /** Name the question card shows. */
  readonly label: string
  /** Values the entry accepts, in catalog order. */
  readonly options: readonly string[]
  /** Value the catalog names as default, when it names one inside `options`. */
  readonly default?: string
}

/** How one requested parameter compares with what the entry accepts. */
export type ParameterCheck =
  | { readonly kind: 'ok'; readonly value: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsupported'; readonly requested: string }

/** One generated image as the card reads it. */
export interface GeneratedImage {
  /** Absolute path of the file in the session's `generated/` directory. */
  readonly path: string
  /** Durable attachment the card loads its thumbnail from, absent when the store refused the file. */
  readonly attachment?: ImageAttachmentRef
}

/** Presentation metadata of one `generate_image` result; never model-visible. */
export interface ImageResultMeta {
  /** Outcome. */
  readonly status: 'generated' | 'cancelled'
  /** Prompt the gateway received. */
  readonly prompt: string
  /** Wire model id. */
  readonly model: string
  /** Name of the model the card shows. */
  readonly modelLabel: string
  /** Parameters the submission sent, by catalog key. */
  readonly parameters: Readonly<Record<string, string>>
  /** Generated images in submission order. */
  readonly images: readonly GeneratedImage[]
}
