/**
 * The canvas file of one project directory: validated reads and serialized, atomic rewrites.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { EMPTY_CANVAS, parseCanvas, serializeCanvas } from './document.ts'
import type { CanvasDocument } from './types.ts'

/**
 * Canvas file of a project directory.
 * @param directory - absolute project directory.
 * @returns absolute path of its canvas document.
 */
export function canvasFile(directory: string): string {
  return join(directory, '.canvas', 'canvas.json')
}

/** Reads and rewrites canvas files; rewrites of one file never interleave. */
export class CanvasStore {
  private readonly tails = new Map<string, Promise<unknown>>()

  /**
   * Read a project's canvas.
   * @param directory - absolute project directory.
   * @returns the document, or the empty canvas when the project has no canvas file.
   * @throws `CanvasCorruptError` when the file is not a valid document.
   */
  async read(directory: string): Promise<CanvasDocument> {
    let source: string
    try {
      source = await readFile(canvasFile(directory), 'utf8')
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return EMPTY_CANVAS
      throw error
    }
    return parseCanvas(source)
  }

  /**
   * Rewrite a project's canvas from its current content.
   * @param directory - absolute project directory.
   * @param change - computes the next document and a value for the caller; returning no document leaves the file untouched.
   * @returns the value `change` produced.
   * @throws `CanvasCorruptError` when the current file is not a valid document; the file is left untouched.
   */
  update<T>(directory: string, change: (current: CanvasDocument) => { readonly document?: CanvasDocument; readonly value: T }): Promise<T> {
    const file = canvasFile(directory)
    const run = async (): Promise<T> => {
      const { document, value } = change(await this.read(directory))
      if (document === undefined) return value
      const temporary = `${file}.${randomUUID()}.tmp`
      await mkdir(dirname(file), { recursive: true })
      try {
        await writeFile(temporary, serializeCanvas(document))
        await rename(temporary, file)
      } catch (error: unknown) {
        await rm(temporary, { force: true })
        throw error
      }
      return value
    }
    const result = (this.tails.get(file) ?? Promise.resolve()).then(run, run)
    const tail = result.catch(() => undefined).finally(() => {
      if (this.tails.get(file) === tail) this.tails.delete(file)
    })
    this.tails.set(file, tail)
    return result
  }
}
