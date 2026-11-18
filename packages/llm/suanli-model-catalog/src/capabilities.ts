import type { CapabilityClass, ClassMembers, GatewayCapability } from './types.ts'

/** Mapping from the gateway's capability catalog to the product's capability classes. */

/** Operation/task pairs this product names; every other pair lands in `other`. */
const CLASSES: readonly {
  readonly capability: CapabilityClass
  readonly operation: string
  readonly tasks?: readonly string[]
}[] = [
  { capability: 'chat', operation: 'chat' },
  { capability: 'image.generate', operation: 'generate_image', tasks: ['t2i'] },
  { capability: 'image.edit', operation: 'generate_image', tasks: ['i2i'] },
  { capability: 'video.generate', operation: 'generate_video', tasks: ['t2v', 't2va', 'auto'] },
  { capability: 'video.first-last-frame', operation: 'generate_video', tasks: ['flf2v', 'fl2va', 'i2v', 'l2va', 's2v'] },
  { capability: 'video.reference', operation: 'generate_video', tasks: ['r2va', 'r2v', 'rv2v'] },
  { capability: 'music.generate', operation: 'generate_music', tasks: ['t2m'] },
  { capability: 'speech.generate', operation: 'generate_speech' },
]

/**
 * Classify one entry: the first class whose operation matches and whose tasks intersect wins,
 * and an entry without task types belongs to its operation's first class.
 * @param entry - capability entry from the gateway.
 * @returns the class it belongs to.
 */
export function classify(entry: GatewayCapability): CapabilityClass {
  const tasks = entry.taskTypes.map(task => task.toLowerCase())
  for (const candidate of CLASSES) {
    if (candidate.operation !== entry.operation) continue
    if (candidate.tasks === undefined) return candidate.capability
    if (tasks.length === 0) continue
    if (tasks.some(task => candidate.tasks?.includes(task) === true)) return candidate.capability
  }
  return 'other'
}

/**
 * Group entries into classes, keeping catalog order and dropping repeats inside a class.
 * @param entries - capability entries from the gateway.
 * @returns one member list per class that holds at least one model.
 */
export function classMembers(entries: readonly GatewayCapability[]): ClassMembers[] {
  const groups = new Map<CapabilityClass, string[]>()
  for (const entry of entries) {
    const capability = classify(entry)
    const models = groups.get(capability) ?? []
    if (!models.includes(entry.model)) models.push(entry.model)
    groups.set(capability, models)
  }
  const order: CapabilityClass[] = ['chat', 'vision.image', 'vision.video', 'image.generate', 'image.edit',
    'video.generate', 'video.first-last-frame', 'video.reference', 'music.generate', 'speech.generate', 'other']
  return order.flatMap((capability) => {
    const models = groups.get(capability)
    return models === undefined ? [] : [{ capability, models }]
  })
}

/** One entry as decoded from the gateway payload. */
function entryOf(row: unknown): GatewayCapability | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const { operation, model, taskTypes, limits } = row as {
    operation?: unknown
    model?: unknown
    taskTypes?: unknown
    limits?: { maxReferenceImages?: unknown }
  }
  if (typeof operation !== 'string' || operation === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  const tasks = Array.isArray(taskTypes)
    ? taskTypes.filter((task: unknown): task is string => typeof task === 'string')
    : []
  const references = limits?.maxReferenceImages
  return {
    operation,
    model,
    taskTypes: tasks,
    maxReferenceImages: typeof references === 'number' && Number.isSafeInteger(references) && references > 0 ? references : 0,
  }
}

/**
 * Decode the gateway capability payload.
 * @param payload - parsed `GET /v1/ov/capabilities` body.
 * @returns the entries, or `undefined` when the payload carries no capability list.
 */
export function parseCapabilities(payload: unknown): GatewayCapability[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const capabilities = (payload as { capabilities?: unknown }).capabilities
  if (!Array.isArray(capabilities)) return undefined
  return capabilities.flatMap((row) => {
    const entry = entryOf(row)
    return entry === undefined ? [] : [entry]
  })
}
