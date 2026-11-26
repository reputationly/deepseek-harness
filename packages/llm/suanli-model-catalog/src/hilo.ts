/** Decoding of the Hilo model catalog (`GET /api/v1/models/catalog`) into the entries this product consumes. */
import type {
  CapabilityEntry, CapabilityMode, CapabilityParameter, HiloDefaults, HiloTextModel, ModeReferences,
} from './types.ts'

/** One decoded Hilo catalog. */
export interface DecodedHiloCatalog {
  /** Content hash the gateway stamped, absent when it declares none. */
  readonly version: string | null
  /** Generation entries of the image, video, and audio sections, in catalog order. */
  readonly entries: readonly CapabilityEntry[]
  /** Chat models of the text section, in catalog order. */
  readonly text: readonly HiloTextModel[]
  /** Role defaults the catalog declares. */
  readonly defaults: HiloDefaults
  /** Rows dropped because they carried no id or platform model. */
  readonly dropped: number
  /** Interface types this product does not know, each listed once. */
  readonly unknownInterfaces: readonly string[]
}

/** How one catalog section and interface type is called. */
interface Route {
  readonly operation: string
  readonly transport: string
}

/** Interface types each section accepts; an empty or unknown value takes the section's first route. */
const ROUTES: Readonly<Record<'image' | 'video' | 'audio', Readonly<Record<string, Route>>>> = {
  image: { 'maas-image': { operation: 'generate_image', transport: 'images' } },
  video: { 'maas-video': { operation: 'generate_video', transport: 'videos_task' } },
  audio: {
    'maas-music': { operation: 'generate_music', transport: 'videos_task' },
    'maas-speech': { operation: 'generate_speech', transport: 'audio_speech' },
  },
}

/** Route of a section whose entry declares no interface type, or one this product does not know. */
const FALLBACK: Readonly<Record<'image' | 'video' | 'audio', Route>> = {
  image: { operation: 'generate_image', transport: 'images' },
  video: { operation: 'generate_video', transport: 'videos_task' },
  audio: { operation: 'generate_music', transport: 'videos_task' },
}

/** No references accepted. */
const NONE = { min: 0, max: 0 }

/**
 * Plays a video entry offers, keyed by the `image_mode` value the gateway accepts.
 * The rules are the gateway's video play protocol, not any model's.
 */
const PLAYS: Readonly<Record<string, Omit<CapabilityMode, 'id'>>> = {
  'text-to-video': {
    label: { zh: '文生视频', en: 'Text to video' },
    taskType: 't2v',
    references: { image: NONE, video: NONE, audio: NONE },
  },
  'first-last-frame': {
    label: { zh: '首尾帧', en: 'First/last frame' },
    taskType: 'flf2v',
    taskTypeIfSingleImage: 'i2v',
    references: { image: { min: 1, max: 2 }, video: NONE, audio: NONE },
  },
  'reference': {
    label: { zh: '参考生成', en: 'Reference' },
    taskType: 'r2va',
    references: { image: { min: 0, max: 9 }, video: { min: 0, max: 3 }, audio: { min: 0, max: 3 } } satisfies ModeReferences,
    note: { zh: '至少给一项参考；视频与音频合计不超过 3 个', en: 'Give at least one reference; at most 3 videos and audios combined' },
  },
  'video-extension': {
    label: { zh: '视频续写', en: 'Extend video' },
    taskType: 'continuation',
    references: { image: NONE, video: { min: 1, max: 1 }, audio: NONE },
    requiresSourceVideo: true,
    note: { zh: '只支持 768P；时长是续写后的总时长', en: '768P only; the duration is the total after extension' },
  },
}

/** A plain data object, as a gateway payload provides one. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A non-empty string, or `undefined`. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Every string of a list. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry: unknown): entry is string => typeof entry === 'string') : []
}

/** One label shown the same in both languages, because the catalog carries a single text. */
function label(value: string): { zh: string; en: string } {
  return { zh: value, en: value }
}

/**
 * Parameters of one entry, keyed by the name a submission uses.
 * A `select` keeps its options; a `textarea` is free text; any other kind is dropped.
 */
function parameters(value: unknown): Record<string, CapabilityParameter> {
  const source = record(value) ?? {}
  const out: Record<string, CapabilityParameter> = {}
  for (const [name, raw] of Object.entries(source)) {
    const spec = record(raw)
    if (spec === undefined) continue
    const title = text(spec.label)
    const fallback = text(spec.default)
    if (spec.type === 'select') {
      const options = strings(spec.options)
      if (options.length === 0) continue
      out[name] = {
        type: 'string',
        ...title === undefined ? {} : { title },
        enum: options,
        ...fallback !== undefined && options.includes(fallback) ? { default: fallback } : {},
      }
    } else if (spec.type === 'textarea') {
      out[name] = { type: 'string', ...title === undefined ? {} : { title } }
    }
  }
  return out
}

/** Longest duration a parameter table offers, in seconds. */
function longest(params: Readonly<Record<string, CapabilityParameter>>): number {
  const seconds = (params.duration?.enum ?? []).map(Number).filter(Number.isFinite)
  return seconds.length === 0 ? 0 : Math.max(...seconds)
}

/** Plays a video entry offers, in the order its `image_mode` options list them. */
function plays(params: Readonly<Record<string, CapabilityParameter>>): CapabilityMode[] {
  return (params.image_mode?.enum ?? []).flatMap((id) => {
    const play = PLAYS[id]
    return play === undefined ? [] : [{ id, ...play }]
  })
}

/** Task types one generation entry serves. */
function taskTypes(operation: string, maxRefs: number, modes: readonly CapabilityMode[]): string[] {
  if (operation === 'generate_image') return maxRefs > 0 ? ['t2i', 'i2i'] : ['t2i']
  if (operation === 'generate_video') return modes.map(play => play.taskType)
  if (operation === 'generate_music') return ['t2m']
  return []
}

/**
 * Decode one Hilo catalog payload.
 * @param payload - parsed body of `GET /api/v1/models/catalog`.
 * @returns the catalog, or `undefined` when the payload carries none of the catalog sections.
 */
export function decodeHiloCatalog(payload: unknown): DecodedHiloCatalog | undefined {
  const source = record(payload)
  if (source === undefined) return undefined
  if (!(['image', 'video', 'audio', 'text'] as const).some(section => Array.isArray(source[section]))) return undefined
  const entries: CapabilityEntry[] = []
  const unknown = new Set<string>()
  let dropped = 0
  for (const section of ['image', 'video', 'audio'] as const) {
    const rows = Array.isArray(source[section]) ? source[section] as unknown[] : []
    const routes = ROUTES[section]
    const fallback = FALLBACK[section]
    for (const row of rows) {
      const item = record(row)
      const id = text(item?.id)
      const model = text(item?.platformModel)
      if (item === undefined || id === undefined || model === undefined) {
        dropped += 1
        continue
      }
      const declared = text(item.interfaceType)
      if (declared !== undefined && routes[declared] === undefined) unknown.add(declared)
      const route = (declared === undefined ? undefined : routes[declared]) ?? fallback
      const params = parameters(item.params)
      const maxRefs = typeof item.maxRefs === 'number' && Number.isSafeInteger(item.maxRefs) && item.maxRefs > 0 ? item.maxRefs : 0
      const modes = route.operation === 'generate_video' ? plays(params) : []
      const tasks = taskTypes(route.operation, maxRefs, modes)
      const name = text(item.displayName) ?? id
      entries.push({
        id: `${route.operation}:${model}`,
        operation: route.operation,
        model,
        displayName: label(name),
        description: label(text(item.description) ?? ''),
        transport: { kind: route.transport },
        ...tasks.length === 0 ? {} : { taskTypes: tasks },
        ...Object.keys(params).length === 0 ? {} : { paramSchema: { type: 'object', properties: params } },
        limits: { maxReferenceImages: maxRefs, maxDurationSeconds: longest(params), maxInputBytes: 0 },
        ...modes.length === 0 ? {} : { modes },
        default: !entries.some(previous => previous.operation === route.operation),
      })
    }
  }
  const chat: HiloTextModel[] = []
  for (const row of Array.isArray(source.text) ? source.text as unknown[] : []) {
    const item = record(row)
    const model = text(item?.platformModel) ?? text(item?.id)
    if (item === undefined || model === undefined) {
      dropped += 1
      continue
    }
    if (chat.some(previous => previous.model === model)) continue
    chat.push({
      model,
      label: text(item.displayName) ?? model,
      supportsImage: item.supportsImage === true,
      supportsVideo: item.supportsVideo === true,
      supportsAudio: item.supportsAudio === true,
    })
  }
  const roles = record(source.defaults)
  const version = text(source.version)
  return {
    version: version ?? null,
    entries,
    text: chat,
    defaults: { chat: text(roles?.chat) ?? null, multimodal: text(roles?.multimodal) ?? null },
    dropped,
    unknownInterfaces: [...unknown],
  }
}
