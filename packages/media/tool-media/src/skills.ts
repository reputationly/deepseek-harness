/**
 * The skills tool-media ships: one directory per skill under the configured root, each with a
 * `SKILL.md` whose frontmatter names it.
 * @module
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'

/** One skill read from disk. */
export interface SkillSource {
  readonly name: string
  readonly description: string
  /** Body after the frontmatter. */
  readonly content: string
  /** Absolute path of its SKILL.md. */
  readonly locator: string
  /** Absolute directory that holds its resources. */
  readonly directory: string
}

/** Frontmatter fields a skill must declare. */
interface Frontmatter {
  readonly name: string
  readonly description: string
  readonly body: string
}

function frontmatterOf(raw: string, path: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match?.[1] === undefined) throw new Error(`tool-media: ${path} has no YAML frontmatter`)
  const name = /^name:\s*(.+)$/mu.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/gu, '')
  const description = /^description:\s*(.+)$/mu.exec(match[1])?.[1]?.trim().replace(/^["']|["']$/gu, '')
  if (name === undefined || name === '') throw new Error(`tool-media: ${path} has no name`)
  if (description === undefined || description === '') throw new Error(`tool-media: ${path} has no description`)
  return { name, description, body: raw.slice(match[0].length).trim() }
}

/**
 * Read one skill directory.
 * @param directory - directory holding `SKILL.md`.
 * @returns the skill, named after its frontmatter.
 * @throws Error when the frontmatter is missing, unnamed, or names another skill than the directory.
 */
export function readSkill(directory: string): SkillSource {
  const locator = join(directory, 'SKILL.md')
  const frontmatter = frontmatterOf(readFileSync(locator, 'utf8'), locator)
  const directoryName = basename(directory)
  if (frontmatter.name !== directoryName) {
    throw new Error(`tool-media: ${locator} names skill ${frontmatter.name} but lives in ${directoryName}`)
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    content: frontmatter.body,
    locator,
    directory,
  }
}

/**
 * Directories under a root that hold a `SKILL.md`, in name order.
 * @param root - absolute skill root.
 * @returns absolute skill directories.
 */
export function skillDirectories(root: string): readonly string[] {
  return readdirSync(root)
    .sort()
    .map(name => join(root, name))
    .filter(path => statSync(path).isDirectory())
    .filter(path => statSync(join(path, 'SKILL.md'), { throwIfNoEntry: false }) !== undefined)
}

/**
 * Resolve the skill root a deployment configured.
 * @param configured - `skillsRoot` from config, absolute or relative to this package.
 * @returns the absolute root.
 */
export function resolveSkillRoot(configured: string): string {
  if (isAbsolute(configured)) return configured
  return fileURLToPath(new URL(configured.endsWith('/') ? configured : `${configured}/`, import.meta.url))
}

/**
 * Register the provider that lists this package's bundled skills.
 * @param ctx - context whose effect owns the registration.
 * @param skills - skill registry the provider registers with.
 * @param root - absolute skill root.
 * @throws Error when a skill directory has no valid `SKILL.md` or names a different skill than its directory.
 */
export function registerMediaSkills(
  ctx: Context,
  skills: { registerProvider(create: () => SkillProvider): () => void },
  root: string,
): void {
  const sources = skillDirectories(root).map(readSkill)
  const byName = new Map(sources.map(skill => [skill.name, skill]))
  const candidates: readonly SkillCandidate[] = sources.map(skill => ({
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'dsh-tool-media',
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: skill.directory.split('\\').join('/') },
    locator: skill.locator,
  }))
  const provider: SkillProvider = {
    name: 'dsh-tool-media',
    list: () => Promise.resolve([...candidates]),
    async get(skill, options) {
      const { rank: _rank, locator, ...summary } = skill
      if (typeof locator !== 'string') throw new Error('tool-media: invalid skill locator')
      const source = byName.get(skill.name)
      if (source === undefined) throw new Error(`tool-media: unknown skill ${skill.name}`)
      const raw = await readFile(locator, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: frontmatterOf(raw, locator).body }
    },
  }
  ctx.effect(() => skills.registerProvider(() => provider), 'tool-media: bundled skills')
}
