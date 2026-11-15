/** Immutable predecessor files; callers hold the project's writer queue while reading or archiving. */
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { CanvasCorruptError } from './document.ts'

async function revisions(file: string): Promise<readonly number[]> {
  let entries: string[]
  try {
    entries = await readdir(`${file}.history`)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter(entry => /^[1-9][0-9]*\.json$/.test(entry))
    .map(entry => Number(entry.slice(0, -5)))
    .filter(Number.isSafeInteger)
}

/**
 * Read retained predecessors; a failed main write's extra snapshot is never presented as a revision.
 * @param file - canonical absolute document file.
 * @param current - validated live document.
 * @param parse - owning document parser.
 * @param limit - maximum preceding revision window.
 * @returns preceding documents newest first, excluding the live document.
 */
export async function readDocumentHistory<D extends { readonly revision: number }>(
  file: string,
  current: D,
  parse: (source: string) => D,
  limit: number,
): Promise<readonly D[]> {
  const kept = (await revisions(file))
    .filter(revision => revision < current.revision && revision >= current.revision - limit)
    .sort((a, b) => b - a)
  return Promise.all(
    kept.map(async (revision) => {
      const document = parse(await readFile(join(`${file}.history`, `${String(revision)}.json`), 'utf8'))
      if (document.revision !== revision) throw new CanvasCorruptError('history filename and document revision differ')
      return document
    }),
  )
}

/**
 * Archive before replacing the main file. Failures leave its committed history window intact.
 * @param file - canonical absolute document file.
 * @param current - persisted predecessor, never an invented revision zero.
 * @param parse - owning document parser.
 * @param limit - number of prior revisions retained in addition to the live document.
 */
export async function archiveDocument<D extends { readonly revision: number }>(
  file: string,
  current: D,
  parse: (source: string) => D,
  limit: number,
): Promise<void> {
  const path = join(`${file}.history`, `${String(current.revision)}.json`)
  let existing: string | undefined
  try {
    existing = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  if (existing === undefined) await writeFileAtomic(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o666 })
  else if (JSON.stringify(parse(existing)) !== JSON.stringify(current))
    throw new CanvasCorruptError('history would replace an immutable revision')
  // Keep the old live document's entire window if the following main write fails.
  for (const revision of await revisions(file))
    if (revision < current.revision - limit) await rm(join(`${file}.history`, `${String(revision)}.json`))
}
