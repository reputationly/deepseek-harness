/**
 * The one question card a generation call raises when a parameter is missing or unsupported,
 * and the reading of its answers back into catalog values.
 */

import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ParameterKind } from './params.ts'
import { check } from './params.ts'
import type { ParameterCheck, ParameterSpec } from './types.ts'

/** Option label of catalog values that are not self-describing. */
/** Most options one question lists; the user can still type any supported value. */
const MAX_OPTIONS = 6

const OPTION_LABELS: Readonly<Record<string, string>> = { adaptive: '自适应' }

/** One parameter the card asks about. */
export interface OpenParameter {
  /** Parameter the entry declares. */
  readonly spec: ParameterSpec
  /** How user wording maps to its values. */
  readonly kind: ParameterKind
  /** Why it is asked. */
  readonly check: Exclude<ParameterCheck, { kind: 'ok' }>
}

/**
 * Label one catalog value shows on the card.
 * @param kind - how the parameter reads.
 * @param value - catalog value.
 * @returns the label.
 */
function labelOf(kind: ParameterKind, value: string): string {
  return kind.labels?.[value] ?? OPTION_LABELS[value] ?? value
}

/**
 * Options of one question, the catalog default first, at most `MAX_OPTIONS` of them.
 * @param open - the parameter.
 * @returns the card options.
 */
function optionsOf(open: OpenParameter): NonNullable<AskUserQuestionItem['options']> {
  const { spec, kind } = open
  const rest = spec.options.filter(option => option !== spec.default)
  const room = MAX_OPTIONS - (spec.default === undefined ? 0 : 1)
  const shown = rest.length <= room
    ? rest
    : Array.from({ length: room }, (_, index) => rest[Math.round(index * (rest.length - 1) / (room - 1))] ?? '')
  const ordered = spec.default === undefined ? shown : [spec.default, ...shown]
  return ordered.map(value => ({ label: labelOf(kind, value), ...value === spec.default ? { description: '默认' } : {} }))
}

/**
 * Supported values in the card's words; a long numeric set reads as its range.
 * @param open - the parameter.
 * @returns the wording.
 */
function supportedOf(open: OpenParameter): string {
  const numbers = open.spec.options.map(Number)
  if (open.spec.options.length > MAX_OPTIONS && numbers.every(Number.isFinite)) {
    return `${String(Math.min(...numbers))} 到 ${String(Math.max(...numbers))}，最长 ${String(Math.max(...numbers))}`
  }
  return open.spec.options.map(value => labelOf(open.kind, value)).join('、')
}

/**
 * Build the question of one open parameter.
 * @param open - the parameter and why it is asked.
 * @returns the card item.
 */
export function questionOf(open: OpenParameter): AskUserQuestionItem {
  const supported = supportedOf(open)
  return {
    id: open.spec.key,
    header: open.spec.label,
    question: open.check.kind === 'unsupported'
      ? `当前不支持「${open.check.requested}」，请选择${open.spec.label}`
      : `请选择${open.spec.label}`,
    ...open.check.kind === 'unsupported' ? { detail: `支持：${supported}` } : {},
    options: optionsOf(open),
  }
}

/**
 * Read one answer back into a catalog value.
 * @param open - the parameter asked.
 * @param answer - the user's answer to it, if any.
 * @returns the catalog value, `'skipped'` when the user gave none, or the check of an invalid custom value.
 */
export function readAnswer(open: OpenParameter, answer: AskUserQuestionAnswerItem | undefined): ParameterCheck | 'skipped' {
  const custom = answer?.custom?.trim()
  const picked = custom !== undefined && custom !== '' ? custom : answer?.selected[0]
  if (picked === undefined) return 'skipped'
  const labelled = open.spec.options.find(option => labelOf(open.kind, option) === picked)
  return check(open.spec, open.kind, labelled ?? picked)
}
