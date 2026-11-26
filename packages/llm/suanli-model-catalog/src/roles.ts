/** Model roles derived from the Hilo catalog, and the store of the user's role choices and preferences. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  CapabilityEntry, HiloDefaults, HiloTextModel, MediaPreferences, ModelRole, ModelRoleCandidate, ModelRoleState,
} from './types.ts'

/** Roles in the order the product lists them. */
export const MODEL_ROLES: readonly ModelRole[] = ['chat', 'vision', 'image', 'video', 'music', 'speech']

/** Generation operation each media role draws its candidates from. */
const ROLE_OPERATIONS: Readonly<Record<'image' | 'video' | 'music' | 'speech', string>> = {
  image: 'generate_image',
  video: 'generate_video',
  music: 'generate_music',
  speech: 'generate_speech',
}

/** Preferences a user who never set one gets. */
export const DEFAULT_PREFERENCES: MediaPreferences = { autoReview: true }

/** The user's choice per role; a role absent here has no choice. */
export type RoleChoices = Readonly<Partial<Record<ModelRole, string>>>

/**
 * Models each role can use and which one it uses now.
 *
 * The chat role lists the catalog's chat models but takes no choice here: the conversation's model picker owns it.
 * @param entries - generation entries of the catalog.
 * @param text - chat models of the catalog.
 * @param defaults - role defaults of the catalog.
 * @param choices - the user's stored choices.
 * @returns one state per role, in {@link MODEL_ROLES} order.
 */
export function deriveRoles(
  entries: readonly CapabilityEntry[],
  text: readonly HiloTextModel[],
  defaults: HiloDefaults,
  choices: RoleChoices,
): ModelRoleState[] {
  const chatModels = text.map(model => ({ model: model.model, label: model.label }))
  const vision = text.filter(model => model.supportsImage || model.supportsVideo).map(model => ({ model: model.model, label: model.label }))
  const state = (role: ModelRole, candidates: readonly ModelRoleCandidate[], preferred: string | null): ModelRoleState => {
    const chosen = role === 'chat' ? undefined : choices[role]
    const has = (model: string | null | undefined): model is string =>
      model != null && candidates.some(candidate => candidate.model === model)
    return {
      role,
      candidates,
      selected: has(chosen) ? chosen : null,
      fallback: has(preferred) ? preferred : candidates[0]?.model ?? null,
    }
  }
  return MODEL_ROLES.map((role) => {
    if (role === 'chat') return state(role, chatModels, defaults.chat)
    if (role === 'vision') return state(role, vision, defaults.multimodal)
    const operation = ROLE_OPERATIONS[role]
    const candidates = entries
      .filter(entry => entry.operation === operation)
      .map(entry => ({ model: entry.model, label: entry.displayName.zh || entry.displayName.en || entry.model }))
    return state(role, candidates, null)
  })
}

/** Stored form of one role choice; an empty model clears it. */
const choiceSchema = z.object({ model: z.string() })
/** Stored form of one boolean preference. */
const preferenceSchema = z.object({ enabled: z.boolean() })

/**
 * Domain declaration of the role choices and generation preferences.
 *
 * They live in a storage domain rather than settings because the desktop shell rewrites the profile patch on every launch.
 */
export const modelRolesDomain = defineDomain({
  name: 'suanli_model_roles',
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: { choice: domainTable(choiceSchema), preference: domainTable(preferenceSchema) },
})

/** The operations the role store needs from an opened table. */
export interface KeyedTable<T> {
  /**
   * Read one record.
   * @param key - record key.
   * @returns the record, or `undefined` when absent.
   */
  get(key: string): T | undefined
  /**
   * Store one record durably.
   * @param key - record key.
   * @param value - the whole record.
   */
  put(key: string, value: T): Promise<void>
}

/** Durable storage of role choices and preferences. */
export interface RoleStore {
  /**
   * Read the stored choices.
   * @returns the choice of each role that has one.
   */
  choices(): RoleChoices
  /**
   * Store or clear one role's choice.
   * @param role - the role.
   * @param model - the chosen model, or `null` to clear the choice.
   */
  choose(role: ModelRole, model: string | null): Promise<void>
  /**
   * Read the stored preferences.
   * @returns the preferences, defaults where none is stored.
   */
  preferences(): MediaPreferences
  /**
   * Store whether generated media is reviewed.
   * @param enabled - the new value.
   */
  setAutoReview(enabled: boolean): Promise<void>
}

/** Key the review preference is stored under. */
const AUTO_REVIEW_KEY = 'auto-review'

/**
 * Keep role choices and preferences in opened domain tables.
 * @param tables - the opened `choice` and `preference` tables of {@link modelRolesDomain}.
 * @param tables.choice - role choices keyed by role.
 * @param tables.preference - preferences keyed by name.
 * @returns the store the catalog service reads and writes.
 */
export function domainRoleStore(tables: {
  readonly choice: KeyedTable<z.infer<typeof choiceSchema>>
  readonly preference: KeyedTable<z.infer<typeof preferenceSchema>>
}): RoleStore {
  return {
    choices: () => Object.fromEntries(MODEL_ROLES.flatMap((role) => {
      const model = tables.choice.get(role)?.model
      return model === undefined || model === '' ? [] : [[role, model]]
    })),
    choose: async (role, model) => { await tables.choice.put(role, { model: model ?? '' }) },
    preferences: () => ({ autoReview: tables.preference.get(AUTO_REVIEW_KEY)?.enabled ?? DEFAULT_PREFERENCES.autoReview }),
    setAutoReview: async (enabled) => { await tables.preference.put(AUTO_REVIEW_KEY, { enabled }) },
  }
}

/**
 * Keep role choices and preferences for this process only, for a deployment without the storage domain.
 * @returns a store whose contents end with the process.
 */
export function memoryRoleStore(): RoleStore {
  const chosen = new Map<ModelRole, string>()
  let preferences = DEFAULT_PREFERENCES
  return {
    choices: () => Object.fromEntries(chosen),
    choose: (role, model) => {
      if (model === null) chosen.delete(role)
      else chosen.set(role, model)
      return Promise.resolve()
    },
    preferences: () => preferences,
    setAutoReview: (enabled) => {
      preferences = { autoReview: enabled }
      return Promise.resolve()
    },
  }
}
