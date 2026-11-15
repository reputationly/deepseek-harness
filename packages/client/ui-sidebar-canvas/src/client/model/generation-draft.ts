/** Field baselines let a form merge unrelated changes without replaying an old generation snapshot. */
import type { CanvasNode, CanvasOperation } from '@deepseek-ai/dsh-canvas/client'

type Value = string | number | boolean

/** Editable generation fields, excluding canvas identity and runtime status. */
export interface GenerationValues {
  readonly model: string | undefined
  readonly prompt: string
  readonly params: Readonly<Record<string, Value>>
}

/** Values as first edited and as currently entered by the user. */
export interface GenerationDraft {
  readonly revision: number
  readonly base: GenerationValues
  readonly value: GenerationValues
}

/**
 * Read normalized editable fields without retaining a node snapshot.
 * @param node - current canvas node.
 * @returns independently editable generation values.
 */
export function generationValues(node: CanvasNode): GenerationValues {
  return { model: node.gen?.model, prompt: node.gen?.prompt ?? '', params: { ...node.gen?.params } }
}

/**
 * Capture the baseline of a new edit.
 * @param node - node being inspected.
 * @param revision - revision read with the node.
 * @returns a clean draft.
 */
export function createGenerationDraft(node: CanvasNode, revision: number): GenerationDraft {
  const value = generationValues(node)
  return { revision, base: value, value }
}

/**
 * Start a field's baseline at its first user change.
 * @param draft - current inspector draft.
 * @param node - latest external node.
 * @param field - control being changed.
 * @param value - newly entered value.
 * @param key - parameter name when changing a parameter.
 * @returns updated baseline and values.
 */
export function changeGenerationDraft(
  draft: GenerationDraft, node: CanvasNode, field: 'model' | 'prompt' | 'param', value: Value | undefined, key = '',
): GenerationDraft {
  const current = generationValues(node)
  if (field === 'param') {
    const before = draft.value.params[key] === draft.base.params[key] ? current.params[key] : draft.base.params[key]
    const params = Object.fromEntries(Object.entries(draft.base.params).filter(([name]) => name !== key))
    if (before !== undefined) params[key] = before
    return {
      ...draft, base: { ...draft.base, params },
      value: { ...draft.value, params: { ...draft.value.params, [key]: value as Value } },
    }
  }
  const before = draft.value[field] === draft.base[field] ? current[field] : draft.base[field]
  if (field === 'prompt') return {
    ...draft, base: { ...draft.base, prompt: before as string }, value: { ...draft.value, prompt: String(value) },
  }
  return { ...draft, base: { ...draft.base, model: before }, value: { ...draft.value, model: value as string | undefined } }
}

/**
 * Untouched controls follow external edits; edited controls keep their own draft.
 * @param draft - inspector edits.
 * @param node - latest external node.
 * @returns merged values to show in the form.
 */
export function displayedGeneration(draft: GenerationDraft, node: CanvasNode): GenerationValues {
  const current = generationValues(node)
  const params = { ...current.params }
  for (const [key, value] of Object.entries(draft.value.params)) {
    if (value !== draft.base.params[key]) params[key] = value
  }
  return {
    model: draft.value.model === draft.base.model ? current.model : draft.value.model,
    prompt: draft.value.prompt === draft.base.prompt ? current.prompt : draft.value.prompt,
    params,
  }
}

/**
 * Only user-edited fields enter the write; changed baselines require an explicit overwrite.
 * @param draft - inspector edits with field baselines.
 * @param node - latest external node.
 * @returns the minimal update and names of conflicting fields.
 */
export function generationDraftEdit(draft: GenerationDraft, node: CanvasNode): {
  readonly operation: Extract<CanvasOperation, { readonly op: 'set_gen' }>
  readonly conflicts: readonly string[]
} {
  const current = generationValues(node)
  const gen: { model?: string | null; prompt?: string; params?: Record<string, Value> } = {}
  const conflicts: string[] = []
  if (draft.value.model !== draft.base.model) {
    gen.model = draft.value.model ?? null
    if (current.model !== draft.base.model && current.model !== draft.value.model) conflicts.push('model')
  }
  if (draft.value.prompt !== draft.base.prompt) {
    gen.prompt = draft.value.prompt
    if (current.prompt !== draft.base.prompt && current.prompt !== draft.value.prompt) conflicts.push('prompt')
  }
  const params: Record<string, Value> = {}
  for (const [key, value] of Object.entries(draft.value.params)) {
    if (value === draft.base.params[key]) continue
    params[key] = value
    if (current.params[key] !== draft.base.params[key] && current.params[key] !== value) conflicts.push(key)
  }
  if (Object.keys(params).length > 0) gen.params = params
  return { operation: { op: 'set_gen', node: node.id, gen } satisfies CanvasOperation, conflicts }
}
