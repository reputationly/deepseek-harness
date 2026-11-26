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
 * Classes one entry belongs to.
 *
 * One catalog entry covers several plays: an image entry that declares both `t2i` and `i2i`
 * is text-to-image *and* image-to-image, and a music entry that adds `cover` stays music.
 * An entry without task types belongs to its operation's first declared class.
 * @param entry - capability entry from the gateway.
 * @returns the classes it serves, in class order.
 */
export function classify(entry: GatewayCapability): CapabilityClass[] {
  const tasks = entry.taskTypes.map(task => task.toLowerCase())
  const matched = CLASSES.filter((candidate) => {
    if (candidate.operation !== entry.operation) return false
    if (candidate.tasks === undefined) return true
    if (tasks.length === 0) return false
    return tasks.some(task => candidate.tasks?.includes(task) === true)
  })
  return matched.length > 0 ? matched.map(candidate => candidate.capability) : ['other']
}

/**
 * Group entries into classes, keeping catalog order and dropping repeats inside a class.
 * @param entries - capability entries from the gateway.
 * @returns one member list per class that holds at least one model.
 */
export function classMembers(entries: readonly GatewayCapability[]): ClassMembers[] {
  const groups = new Map<CapabilityClass, string[]>()
  for (const entry of entries) {
    for (const capability of classify(entry)) {
      const models = groups.get(capability) ?? []
      if (!models.includes(entry.model)) models.push(entry.model)
      groups.set(capability, models)
    }
  }
  const order: CapabilityClass[] = ['chat', 'vision.image', 'vision.video', 'image.generate', 'image.edit',
    'video.generate', 'video.first-last-frame', 'video.reference', 'music.generate', 'speech.generate', 'other']
  return order.flatMap((capability) => {
    const models = groups.get(capability)
    return models === undefined ? [] : [{ capability, models }]
  })
}
