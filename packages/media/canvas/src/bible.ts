/**
 * The bible of a project: the shared style, characters, locations, and props every episode draws on.
 * @module
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { BibleEntryId, CanvasNodeId } from './types.ts'

/** Voice one speaker uses. */
export interface VoiceSpec {
  /** Speech model id; the deployment default applies when absent. */
  readonly model?: string
  /** Voice id of that model. */
  readonly voice?: string
  /** Node whose current version is the reference sample. */
  readonly sampleNode?: CanvasNodeId
}

/** One character, location, or prop. */
export interface BibleEntry {
  readonly id: BibleEntryId
  readonly kind: 'character' | 'location' | 'prop'
  /** Name prompts refer to as `@name`. */
  readonly name: string
  /** Other spellings that resolve to the same entry. */
  readonly aliases: readonly string[]
  /** Appearance written as a sentence that can go straight into a prompt. */
  readonly description: string
  /** Reference images; the first is the main image. */
  readonly imageNodes: readonly CanvasNodeId[]
  /** Voice of a character. */
  readonly voice?: VoiceSpec
}

/** Shared style every episode follows. */
export interface BibleStyle {
  readonly visual: string
  readonly palette?: string
  readonly aspect: '16:9' | '9:16' | '1:1' | '4:3' | '3:4'
  readonly director?: string
  readonly genre?: string
  readonly tone?: string
}

/** `.canvas/bible.json`. */
export interface Bible {
  readonly version: 1
  /** Incremented by every successful write. */
  readonly revision: number
  readonly logline: string
  readonly style: BibleStyle
  readonly entries: readonly BibleEntry[]
  /** Voice narration uses. */
  readonly narrator?: VoiceSpec
}

const KINDS: readonly BibleEntry['kind'][] = ['character', 'location', 'prop']
const ASPECTS: readonly BibleStyle['aspect'][] = ['16:9', '9:16', '1:1', '4:3', '3:4']

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`bible.json: ${what} is not an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`bible.json: ${what} is not a string`)
  return value
}

function stringList(value: unknown, what: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`bible.json: ${what} is not an array`)
  return value.map((entry, index) => text(entry, `${what}[${String(index)}]`))
}

function voice(value: unknown, what: string): VoiceSpec | undefined {
  if (value === undefined) return undefined
  const raw = record(value, what)
  return {
    ...raw.model === undefined ? {} : { model: text(raw.model, `${what}.model`) },
    ...raw.voice === undefined ? {} : { voice: text(raw.voice, `${what}.voice`) },
    ...raw.sampleNode === undefined ? {} : { sampleNode: brandString<CanvasNodeId>(text(raw.sampleNode, `${what}.sampleNode`)) },
  }
}

/** Entry with its name lowercased, used for mention lookup. */
function namesOf(entry: BibleEntry): readonly string[] {
  return [entry.name, ...entry.aliases].map(name => name.toLowerCase())
}

/**
 * Parse a bible file.
 * @param source - file content.
 * @returns the validated bible.
 * @throws Error naming the field that is not a bible.
 */
export function parseBible(source: string): Bible {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error: unknown) {
    throw new Error(`bible.json: ${String(error)}`)
  }
  const raw = record(value, 'document')
  if (raw.version !== 1) throw new Error(`bible.json: unsupported version ${JSON.stringify(raw.version)}`)
  const revision = raw.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) throw new Error('bible.json: revision is not a non-negative integer')
  const style = record(raw.style, 'style')
  const aspect = text(style.aspect, 'style.aspect')
  if (!(ASPECTS as readonly string[]).includes(aspect)) throw new Error(`bible.json: unknown aspect ${aspect}`)
  const entries = Array.isArray(raw.entries) ? raw.entries.map((entry, index) => parseEntry(entry, index)) : null
  if (entries === null) throw new Error('bible.json: entries is not an array')
  const narrator = voice(raw.narrator, 'narrator')
  const seen = new Set<string>()
  for (const entry of entries) {
    for (const name of namesOf(entry)) {
      if (seen.has(name)) throw new Error(`bible.json: ${entry.name} repeats the name ${name}`)
      seen.add(name)
    }
  }
  return {
    version: 1,
    revision,
    logline: text(raw.logline, 'logline'),
    style: {
      visual: text(style.visual, 'style.visual'),
      ...style.palette === undefined ? {} : { palette: text(style.palette, 'style.palette') },
      aspect: aspect as BibleStyle['aspect'],
      ...style.director === undefined ? {} : { director: text(style.director, 'style.director') },
      ...style.genre === undefined ? {} : { genre: text(style.genre, 'style.genre') },
      ...style.tone === undefined ? {} : { tone: text(style.tone, 'style.tone') },
    },
    entries,
    ...narrator === undefined ? {} : { narrator },
  }
}

function parseEntry(value: unknown, index: number): BibleEntry {
  const raw = record(value, `entries[${String(index)}]`)
  const what = `entries[${String(index)}]`
  const kind = text(raw.kind, `${what}.kind`)
  if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`bible.json: ${what}.kind is ${kind}`)
  const voiceSpec = voice(raw.voice, `${what}.voice`)
  return {
    id: brandString<BibleEntryId>(text(raw.id, `${what}.id`)),
    kind: kind as BibleEntry['kind'],
    name: text(raw.name, `${what}.name`),
    aliases: stringList(raw.aliases, `${what}.aliases`),
    description: text(raw.description, `${what}.description`),
    imageNodes: stringList(raw.imageNodes, `${what}.imageNodes`).map(entry => brandString<CanvasNodeId>(entry)),
    ...voiceSpec === undefined ? {} : { voice: voiceSpec },
  }
}

/**
 * Serialize a bible file.
 * @param bible - validated bible.
 * @returns pretty-printed JSON ending in a newline.
 */
export function serializeBible(bible: Bible): string {
  return `${JSON.stringify(bible, null, 2)}\n`
}

/**
 * Expand `@name` mentions in a prompt.
 * @param prompt - prompt as written.
 * @param bible - bible that supplies the descriptions and main images.
 * @returns the prompt with mentions replaced, the main images the mentions contribute in first-mention
 * order, and the mentions no entry names, left in the prompt as written.
 */
export function expandMentions(
  prompt: string,
  bible: Bible,
): { readonly prompt: string; readonly imageNodes: readonly CanvasNodeId[]; readonly unknown: readonly string[] } {
  const byName = new Map<string, BibleEntry>()
  for (const entry of bible.entries) for (const name of namesOf(entry)) byName.set(name, entry)
  const images: CanvasNodeId[] = []
  const unknown: string[] = []
  const expanded = prompt.replace(/@([\p{L}\p{N}_-]+)/gu, (mention, name: string) => {
    const entry = byName.get(name.toLowerCase())
    if (entry === undefined) {
      unknown.push(mention)
      return mention
    }
    const main = entry.imageNodes[0]
    if (main !== undefined && !images.includes(main)) images.push(main)
    return entry.description
  })
  return { prompt: expanded, imageNodes: images, unknown }
}

/**
 * Entry a mention resolves to.
 * @param bible - bible to search.
 * @param name - name or alias, case-insensitive.
 * @returns the entry, or undefined when no name matches.
 */
export function entryNamed(bible: Bible, name: string): BibleEntry | undefined {
  const lowered = name.toLowerCase()
  return bible.entries.find(entry => namesOf(entry).includes(lowered))
}

/**
 * Bible file of a project.
 * @returns the file path relative to `.canvas/`.
 */
export function bibleFile(): string {
  return 'bible.json'
}

/** The bible of a project that has none yet. */
export const EMPTY_BIBLE: Bible = {
  version: 1,
  revision: 0,
  logline: '',
  style: { visual: '', aspect: '16:9' },
  entries: [],
}
