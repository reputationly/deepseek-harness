/**
 * The one question card a generation call raises when a parameter is missing or unsupported,
 * and the reading of its answers back into catalog values.
 */

import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { ParameterKind } from './params.ts'
import { check } from './params.ts'
import type { ParameterCheck, ParameterSpec } from './types.ts'

/** Option label of catalog values that are not self-describing. */
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
 * @param value - catalog value.
 * @returns the label.
 */
function labelOf(value: string): string {
  return OPTION_LABELS[value] ?? value
}

/**
 * Options of one question, the catalog default first.
 * @param spec - parameter the entry declares.
 * @returns the card options.
 */
function optionsOf(spec: ParameterSpec): NonNullable<AskUserQuestionItem['options']> {
  const ordered = spec.default === undefined ? spec.options : [spec.default, ...spec.options.filter(option => option !== spec.default)]
  return ordered.map(value => ({ label: labelOf(value), ...value === spec.default ? { description: '默认' } : {} }))
}

/**
 * Build the question of one open parameter.
 * @param open - the parameter and why it is asked.
 * @returns the card item.
 */
export function questionOf(open: OpenParameter): AskUserQuestionItem {
  const supported = open.spec.options.map(labelOf).join('、')
  return {
    id: open.spec.key,
    header: open.spec.label,
    question: open.check.kind === 'unsupported'
      ? `当前不支持「${open.check.requested}」，请选择${open.spec.label}`
      : `请选择${open.spec.label}`,
    ...open.check.kind === 'unsupported' ? { detail: `支持：${supported}` } : {},
    options: optionsOf(open.spec),
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
  const labelled = open.spec.options.find(option => labelOf(option) === picked)
  return check(open.spec, open.kind, labelled ?? picked)
}
