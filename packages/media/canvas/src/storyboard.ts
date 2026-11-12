/**
 * Script scene parsing and storyboard checks the canvas shares between Host and Client.
 * @module
 */

import type { Bible } from './bible.ts'
import type { Shot } from './types.ts'

/** One scene parsed out of a script body. */
export interface Scene {
  /** Scene number as written, normalized to half-width digits. */
  readonly number: number
  /** Heading text after the scene marker. */
  readonly title: string
  /** Body between this heading and the next. */
  readonly body: string
}

/** Scene heading marker: 【场1】, 第1场, or 场1, up to where the title starts. */
const HEADING = new RegExp([
  '^[ \\t]*(?:#{1,6}[ \\t]*)?',
  '(?:【[ \\t]*场[ \\t]*([0-9０-９]+)[ \\t]*】|第[ \\t]*([0-9０-９]+)[ \\t]*场|场[ \\t]*([0-9０-９]+))',
  '[ \\t]*[：:.、]?',
].join(''), 'u')

function halfWidth(digits: string): number {
  return Number(digits.replace(/[０-９]/gu, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)))
}

/**
 * Split a script body into its scenes.
 * @param text - script body as written.
 * @returns the scenes in document order; a body with no heading yields one scene numbered 1.
 */
export function parseScenes(text: string): readonly Scene[] {
  const scenes: Scene[] = []
  let current: { number: number; title: string; lines: string[] } | undefined
  for (const line of text.split(/\r?\n/u)) {
    const heading = HEADING.exec(line)
    const digits = heading?.[1] ?? heading?.[2] ?? heading?.[3]
    if (heading !== null && digits !== undefined) {
      if (current !== undefined) scenes.push({ number: current.number, title: current.title, body: current.lines.join('\n').trim() })
      current = { number: halfWidth(digits), title: line.slice(heading[0].length).trim(), lines: [] }
      continue
    }
    if (current !== undefined) current.lines.push(line)
  }
  if (current !== undefined) scenes.push({ number: current.number, title: current.title, body: current.lines.join('\n').trim() })
  if (scenes.length === 0) return [{ number: 1, title: '', body: text.trim() }]
  return scenes
}

/**
 * Check a storyboard table against its bible and the production rules.
 * @param shots - shots as stored on a storyboard version.
 * @param bible - bible the shots may reference.
 * @returns one message per problem, empty when the table passes.
 */
export function validateShots(shots: readonly Shot[], bible: Bible): readonly string[] {
  const problems: string[] = []
  const known = new Set(bible.entries.map(entry => entry.id))
  const ids = new Set<string>()
  for (const shot of shots) {
    if (ids.has(shot.id)) problems.push(`shot ${shot.id} appears twice`)
    ids.add(shot.id)
    if (shot.title.length > 24) problems.push(`shot ${shot.id} title is longer than 24 characters`)
    if (shot.shotSize === undefined) problems.push(`shot ${shot.id} has no shot size`)
    if (!(shot.durationSec >= 1)) problems.push(`shot ${shot.id} is shorter than 1 second`)
    for (const entry of [...shot.characters, ...shot.props, ...shot.scene === undefined ? [] : [shot.scene]]) {
      if (!known.has(entry)) problems.push(`shot ${shot.id} names bible entry ${entry} that does not exist`)
    }
    for (const line of shot.dialogue) {
      if (line.speaker.kind === 'character' && !known.has(line.speaker.entry)) {
        problems.push(`shot ${shot.id} line ${line.id} names bible entry ${line.speaker.entry} that does not exist`)
      }
    }
  }
  return problems
}

/**
 * Bible entries a storyboard table references.
 * @param shots - shots as stored on a storyboard version.
 * @returns the entry ids the table uses, without duplicates, in first-use order.
 */
export function bibleEntriesOf(shots: readonly Shot[]): readonly string[] {
  const used: string[] = []
  for (const shot of shots) {
    for (const entry of [...shot.characters, ...shot.props, ...shot.scene === undefined ? [] : [shot.scene]]) {
      if (!used.includes(entry)) used.push(entry)
    }
    for (const line of shot.dialogue) {
      if (line.speaker.kind === 'character' && !used.includes(line.speaker.entry)) used.push(line.speaker.entry)
    }
  }
  return used
}
