/** Decoding of the gateway's capability catalog into the entries a media workbench consumes. */
import type {
  CapabilityEntry, CapabilityLimits, CapabilityMode, CapabilityParameter, CapabilityParameterSchema,
  GatewayCapability, LocalizedLabel, MediaReferenceRule, ModeReferences,
} from './types.ts'

/** Operations whose entries a media workbench renders. */
const MEDIA_OPERATIONS: readonly string[] = ['generate_image', 'generate_video']

/** One decoded catalog, with the entries it had to drop. */
export interface DecodedCatalog {
  /** Version the gateway stamped, absent when it declares none. */
  readonly version: string | null
  /** Decoded entries, in gateway order. */
  readonly entries: readonly CapabilityEntry[]
  /** Entries dropped because a required field was missing or malformed. */
  readonly dropped: number
}

/** A plain data object, as a gateway payload provides one. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** One localized label, with empty sides for what the gateway omits. */
function localized(value: unknown): LocalizedLabel {
  const source = record(value)
  const zh = source?.zh
  const en = source?.en
  return { zh: typeof zh === 'string' ? zh : '', en: typeof en === 'string' ? en : '' }
}

/** A finite count, or the fallback. */
function count(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Every string of a list, or `undefined` when there is no list. */
function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const listed = value.filter((entry: unknown): entry is string => typeof entry === 'string')
  return listed.length === 0 ? undefined : listed
}

/** One bounded parameter. */
function parameter(value: unknown): CapabilityParameter {
  const source = record(value) ?? {}
  const title = source.title
  const enumeration = strings(source.enum)
  const fallback = source.default
  return {
    type: typeof source.type === 'string' ? source.type : 'string',
    ...typeof title === 'string' ? { title } : {},
    ...enumeration === undefined ? {} : { enum: enumeration },
    ...source.minimum === undefined ? {} : { minimum: count(source.minimum) },
    ...source.maximum === undefined ? {} : { maximum: count(source.maximum) },
    ...typeof fallback === 'string' ? { default: fallback } : {},
  }
}

/** The parameter object of one entry. */
function parameterSchema(value: unknown): CapabilityParameterSchema | undefined {
  const source = record(value)
  const properties = record(source?.properties)
  if (source === undefined || properties === undefined) return undefined
  return {
    type: typeof source.type === 'string' ? source.type : 'object',
    properties: Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, parameter(schema)])),
  }
}

/** How many inputs of one kind a mode accepts. */
function referenceRule(value: unknown): MediaReferenceRule {
  const source = record(value)
  return { min: count(source?.min), max: count(source?.max) }
}

/** Reference rules of one mode. */
function modeReferences(value: unknown): ModeReferences {
  const source = record(value)
  return { image: referenceRule(source?.image), video: referenceRule(source?.video), audio: referenceRule(source?.audio) }
}

/** One play of an entry. */
function mode(value: unknown): CapabilityMode | undefined {
  const source = record(value)
  const id = source?.id
  const taskType = source?.taskType
  if (typeof id !== 'string' || id === '') return undefined
  const single = source?.taskTypeIfSingleImage
  const note = source?.note
  return {
    id,
    label: localized(source?.label),
    taskType: typeof taskType === 'string' ? taskType : '',
    ...typeof single === 'string' && single !== '' ? { taskTypeIfSingleImage: single } : {},
    references: modeReferences(source?.references),
    ...source?.requiresSourceVideo === true ? { requiresSourceVideo: true } : {},
    ...record(note) === undefined ? {} : { note: localized(note) },
  }
}

/** Declared hard limits of one entry. */
function limits(value: unknown): CapabilityLimits {
  const source = record(value)
  return {
    maxReferenceImages: count(source?.maxReferenceImages),
    maxDurationSeconds: count(source?.maxDurationSeconds),
    maxInputBytes: count(source?.maxInputBytes),
  }
}

/** One catalog entry, or `undefined` when a required field is missing. */
function entry(value: unknown): CapabilityEntry | undefined {
  const source = record(value)
  const id = source?.id
  const operation = source?.operation
  const model = source?.model
  const kind = record(source?.transport)?.kind
  if (typeof id !== 'string' || id === '') return undefined
  if (typeof operation !== 'string' || operation === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  if (typeof kind !== 'string' || kind === '') return undefined
  const taskTypes = strings(source?.taskTypes)
  const schema = parameterSchema(source?.paramSchema)
  const durations = Array.isArray(source?.deliveryDurations)
    ? (source.deliveryDurations as unknown[]).filter((seconds: unknown): seconds is number => typeof seconds === 'number' && Number.isFinite(seconds))
    : []
  const modes = Array.isArray(source?.modes)
    ? (source.modes as unknown[]).flatMap((candidate) => {
      const decoded = mode(candidate)
      return decoded === undefined ? [] : [decoded]
    })
    : []
  return {
    id,
    operation,
    model,
    displayName: localized(source?.displayName),
    description: localized(source?.description),
    transport: { kind },
    ...taskTypes === undefined ? {} : { taskTypes },
    ...schema === undefined ? {} : { paramSchema: schema },
    limits: limits(source?.limits),
    ...durations.length === 0 ? {} : { deliveryDurations: durations },
    ...modes.length === 0 ? {} : { modes },
    default: source?.default === true,
  }
}

/**
 * Decode the gateway capability payload.
 * @param payload - parsed body of `GET /v1/ov/capabilities`.
 * @returns the catalog, or `undefined` when the payload carries no capability list.
 */
export function decodeCatalog(payload: unknown): DecodedCatalog | undefined {
  const source = record(payload)
  const listed = source?.capabilities
  if (source === undefined || !Array.isArray(listed)) return undefined
  const entries: CapabilityEntry[] = []
  let dropped = 0
  for (const row of listed as unknown[]) {
    const decoded = entry(row)
    if (decoded === undefined) {
      dropped += 1
      continue
    }
    entries.push(decoded)
  }
  const version = source.version
  return { version: typeof version === 'string' && version !== '' ? version : null, entries, dropped }
}

/**
 * Entries one media workbench renders.
 * @param entries - every entry of a catalog.
 * @returns the entries whose operation produces images or video.
 */
export function mediaEntries(entries: readonly CapabilityEntry[]): readonly CapabilityEntry[] {
  return entries.filter(candidate => MEDIA_OPERATIONS.includes(candidate.operation))
}

/**
 * Project one catalog entry onto the fields capability classes are derived from.
 * @param entry - catalog entry.
 * @returns the reduced entry `classify` reads.
 */
export function asGatewayCapability(entry: CapabilityEntry): GatewayCapability {
  return {
    operation: entry.operation,
    model: entry.model,
    taskTypes: entry.taskTypes ?? [],
    maxReferenceImages: entry.limits.maxReferenceImages,
  }
}
