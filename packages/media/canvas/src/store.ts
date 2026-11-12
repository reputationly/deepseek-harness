/**
 * The canvas files of one project directory: validated reads and serialized, atomic rewrites.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ResolvedConfig } from './config.ts'
import { EMPTY_CANVAS, parseCanvas, serializeCanvas } from './document.ts'
import type { CanvasDocument } from './types.ts'

/**
 * Canvas file of an episode.
 * @param directory - absolute project directory.
 * @param file - episode canvas file relative to `.canvas/`; the single canvas when omitted.
 * @returns absolute path of the canvas document.
 */
export function canvasFile(directory: string, file = 'canvas.json'): string {
  return join(directory, '.canvas', file)
}

/** A stored document with the revision the file holds. */
export interface StoredDocument<T> {
  readonly value: T
  /** Revision read from the file; 0 for a file that does not exist. */
  readonly revision: number
}

/**
 * Reads and rewrites a project's canvas files. Rewrites of one project never interleave, so a
 * change that touches the canvas and a project-level file lands as one serialized step.
 */
export class CanvasStore {
  private readonly tails = new Map<string, Promise<unknown>>()

  /** @param limits - bounds the canvas parser enforces; omitted defaults apply. */
  constructor(private readonly limits?: ResolvedConfig) {}

  /**
   * Read an episode's canvas.
   * @param directory - project directory.
   * @param file - episode canvas file relative to `.canvas/`.
   * @returns the document, or the empty canvas when the file does not exist.
   * @throws `CanvasCorruptError` when the file is not a valid document.
   * @throws `CanvasUnsupportedVersionError` when the file declares a newer format.
   */
  async readCanvas(directory: string, file?: string): Promise<CanvasDocument> {
    let source: string
    try {
      source = await readFile(canvasFile(directory, file), 'utf8')
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return EMPTY_CANVAS
      throw error
    }
    return parseCanvas(source, this.limits)
  }

  /**
   * Rewrite an episode's canvas from its current content.
   * @param directory - project directory.
   * @param file - episode canvas file relative to `.canvas/`.
   * @param change - computes the next document and a value for the caller; returning no document leaves the file untouched.
   * @returns the value `change` produced.
   * @throws `CanvasCorruptError` when the current file is not a valid document; the file is left untouched.
   */
  updateCanvas<T>(
    directory: string,
    file: string,
    change: (current: CanvasDocument) => { readonly document?: CanvasDocument; readonly value: T },
  ): Promise<T> {
    return this.serialize(directory, async () => {
      const { document, value } = change(await this.readCanvas(directory, file))
      if (document === undefined) return value
      await this.write(canvasFile(directory, file), serializeCanvas(document))
      return value
    })
  }

  /**
   * Read a JSON document that a project may not have yet.
   * @param directory - project directory.
   * @param file - file relative to `.canvas/`.
   * @param parse - validator for the file content.
   * @returns the document and its revision, or undefined when the file does not exist.
   * @throws Error when the file content fails validation.
   */
  async readDocument<D extends { readonly revision: number }>(
    directory: string,
    file: string,
    parse: (source: string) => D,
  ): Promise<StoredDocument<D> | undefined> {
    let source: string
    try {
      source = await readFile(join(directory, '.canvas', file), 'utf8')
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const value = parse(source)
    return { value, revision: value.revision }
  }

  /**
   * Rewrite a JSON document that carries a revision, bumping the revision once per write.
   * @param directory - project directory.
   * @param file - file relative to `.canvas/`.
   * @param parse - validator for the file content.
   * @param create - document to start from when the file does not exist.
   * @param change - computes the next document and a value for the caller; returning no document leaves the file untouched.
   * @returns the value `change` produced and the revision the file holds afterwards.
   */
  updateDocument<T, D extends { readonly revision: number }>(
    directory: string,
    file: string,
    parse: (source: string) => D,
    create: () => D,
    change: (current: D) => { readonly document?: D; readonly value: T },
  ): Promise<{ readonly value: T; readonly revision: number }> {
    return this.serialize(directory, async () => {
      const stored = await this.readDocument(directory, file, parse)
      const current = stored?.value ?? create()
      const next = change(current)
      if (next.document === undefined) return { value: next.value, revision: current.revision }
      const revision = current.revision + 1
      const document: D = { ...next.document, revision }
      await this.write(join(directory, '.canvas', file), `${JSON.stringify(document, null, 2)}\n`)
      return { value: next.value, revision }
    })
  }

  /** Run one rewrite of a project after every earlier rewrite of the same project settled. */
  private serialize<T>(directory: string, run: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(directory) ?? Promise.resolve()
    const result = previous.then(run, run)
    const tail = result.catch(() => undefined).finally(() => {
      if (this.tails.get(directory) === tail) this.tails.delete(directory)
    })
    this.tails.set(directory, tail)
    return result
  }

  /** Write one file atomically, creating the directory it lives in. */
  private async write(file: string, content: string): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`
    await mkdir(dirname(file), { recursive: true })
    try {
      await writeFile(temporary, content)
      await rename(temporary, file)
    } catch (error: unknown) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}
