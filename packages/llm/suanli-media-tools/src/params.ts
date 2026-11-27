/**
 * Catalog parameter reading and the synonym table that maps user wording to catalog values.
 * Normalization only renames; a value outside the catalog's set stays unsupported.
 */

import type { CapabilityEntry } from '@deepseek-ai/dsh-suanli-model-catalog/types'
import type { ParameterCheck, ParameterSpec } from './types.ts'

/** Aspect wording users say for a catalog value. */
const ASPECT_WORDS: Readonly<Record<string, string>> = {
  竖屏: '9:16', 竖版: '9:16', 竖图: '9:16', 横屏: '16:9', 横版: '16:9', 横图: '16:9',
  方图: '1:1', 方形: '1:1', 正方形: '1:1', 自适应: 'adaptive', 自动: 'adaptive',
}

/** Words that only decorate a resolution, as in 超清4K. */
const RESOLUTION_DECORATION = /超高清|超清|高清|分辨率|画质|\s/gu

/** Which catalog keys hold one generation parameter. */
export interface ParameterKind {
  /** Keys a catalog may use for this parameter, in preference order. */
  readonly keys: readonly string[]
  /** Label when the catalog gives none. */
  readonly label: string
  /** Map one user wording to a comparable form. */
  readonly normalize: (raw: string) => string
  /** Words the card shows for catalog values, such as `true` → 有声. */
  readonly labels?: Readonly<Record<string, string>>
}

/**
 * Bring one aspect wording to the `W:H` form the catalog uses.
 * @param raw - user wording.
 * @returns comparable form.
 */
export function normalizeAspect(raw: string): string {
  const trimmed = raw.trim()
  const word = ASPECT_WORDS[trimmed]
  if (word !== undefined) return word
  return trimmed.replace(/\s/gu, '').replace(/[：xX×*/]/gu, ':').toLowerCase()
}

/**
 * Bring one resolution wording to the upper-case form the catalog uses.
 * @param raw - user wording.
 * @returns comparable form.
 */
export function normalizeResolution(raw: string): string {
  return raw.replace(RESOLUTION_DECORATION, '').toUpperCase()
}

/** Pixel grid of the gateway's image canvases. */
const CANVAS_GRID = 32

/**
 * Turn the catalog's aspect ratio and `NK` resolution into the `WIDTHxHEIGHT` canvas the image
 * route reads: the area of an N×1024 square at that ratio, each side floored to 32 px, as the
 * gateway's own image playground computes it.
 * @param parameters - resolved image parameters.
 * A resolution that already is `WIDTHxHEIGHT` is the canvas itself.
 * @returns the canvas, or undefined when the ratio is adaptive or either value is not of that form.
 */
export function canvasOf(parameters: Readonly<Record<string, string>>): string | undefined {
  const resolution = parameters.resolution ?? parameters.size ?? ''
  const pixels = /^(\d+)[xX×*](\d+)$/u.exec(resolution)
  if (pixels !== null) return `${pixels[1] ?? ''}x${pixels[2] ?? ''}`
  const ratio = /^(\d+):(\d+)$/u.exec(parameters.aspect_ratio ?? '')
  const tier = /^(\d+)K$/u.exec(resolution)
  if (ratio === null || tier === null) return undefined
  const aspect = Number(ratio[1]) / Number(ratio[2])
  const base = Number(tier[1]) * 1024
  if (!(aspect > 0) || base <= 0) return undefined
  const height = Math.sqrt(base * base / aspect)
  const floor = (side: number): number => Math.max(CANVAS_GRID, Math.floor(side / CANVAS_GRID) * CANVAS_GRID)
  return `${String(floor(aspect * height))}x${String(floor(height))}`
}

/** Aspect ratio of an image. */
export const ASPECT: ParameterKind = { keys: ['aspect_ratio', 'ratio'], label: '宽高比', normalize: normalizeAspect }
/** Resolution tier of an image. */
export const RESOLUTION: ParameterKind = { keys: ['resolution', 'size'], label: '分辨率', normalize: normalizeResolution }

/**
 * Bring one duration wording to whole seconds.
 * @param raw - user wording, such as `10秒` or `10s`.
 * @returns comparable form.
 */
export function normalizeDuration(raw: string): string {
  const trimmed = raw.replace(/\s|秒钟|秒|seconds?|secs?|s$/giu, '')
  const seconds = Number(trimmed)
  return Number.isFinite(seconds) ? String(seconds) : trimmed
}

/** Yes and no wording users say for a switch. */
const YES = /^(true|yes|y|是|有|要|开|开启|需要|有声|带声音|带人声|纯音乐|纯器乐|器乐)$/iu
const NO = /^(false|no|n|否|无|不要|关|关闭|不需要|无声|静音|不带声音|人声|带歌词)$/iu

/**
 * Bring one switch wording to the `true`/`false` form the catalog uses.
 * @param raw - user wording.
 * @returns comparable form.
 */
export function normalizeSwitch(raw: string): string {
  const trimmed = raw.trim()
  if (YES.test(trimmed)) return 'true'
  if (NO.test(trimmed)) return 'false'
  return trimmed.toLowerCase()
}

/** Clip length in seconds. */
export const DURATION: ParameterKind = { keys: ['duration', 'duration_seconds'], label: '时长（秒）', normalize: normalizeDuration }
/** Whether a clip carries generated sound. */
export const AUDIO: ParameterKind = {
  keys: ['generate_audio', 'with_audio', 'audio'], label: '声音', normalize: normalizeSwitch, labels: { true: '有声', false: '无声' },
}
/** Voice of synthesized speech. */
export const VOICE: ParameterKind = { keys: ['voice', 'voice_id'], label: '音色', normalize: raw => raw.trim() }

/** Whether music has no vocals. */
export const INSTRUMENTAL: ParameterKind = {
  keys: ['is_instrumental', 'instrumental'], label: '纯音乐', normalize: normalizeSwitch, labels: { true: '纯音乐', false: '带人声' },
}

/**
 * Read one closed-set parameter from a catalog entry.
 * @param entry - catalog entry of the chosen model.
 * @param kind - which parameter.
 * @returns the parameter, or `undefined` when the entry declares no such set.
 */
export function specOf(entry: CapabilityEntry, kind: ParameterKind): ParameterSpec | undefined {
  const properties = entry.paramSchema?.properties ?? {}
  for (const key of kind.keys) {
    const property = properties[key]
    const options = property?.enum
    if (property === undefined || options === undefined || options.length === 0) continue
    const fallback = property.default
    return {
      key,
      label: property.title !== undefined && property.title !== '' ? property.title : kind.label,
      options,
      ...fallback !== undefined && options.includes(fallback) ? { default: fallback } : {},
    }
  }
  return undefined
}

/**
 * Compare one requested value with the set the entry accepts.
 * @param spec - parameter the entry declares.
 * @param kind - how user wording maps to catalog values.
 * @param requested - the value the call carries, if any.
 * @returns the catalog value, or why there is none.
 */
export function check(spec: ParameterSpec, kind: ParameterKind, requested: string | undefined): ParameterCheck {
  if (requested === undefined || requested.trim() === '') return { kind: 'missing' }
  const wanted = kind.normalize(requested)
  const value = spec.options.find(option => kind.normalize(option) === wanted)
  return value === undefined ? { kind: 'unsupported', requested: requested.trim() } : { kind: 'ok', value }
}
