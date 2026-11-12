/**
 * Project canvas: one document per project directory, edited by the model through `canvas_get` and
 * `canvas_edit`, by users through the `canvas` Remote namespace, and read by media tools for inputs.
 * @module @deepseek-ai/dsh-canvas
 */

import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-working-directory'
import { CanvasCorruptError } from './document.ts'
import { applyOperations } from './operations.ts'
import { canvasFile, CanvasStore } from './store.ts'
import { registerCanvasTools } from './tools.ts'
import type { CanvasDocument, CanvasEditResult, CanvasNode, CanvasOperation, CanvasView } from './types.ts'

export type * from './types.ts'
export { CanvasCorruptError } from './document.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Project canvas documents and the `canvas` Remote namespace. */
    canvas: CanvasService
  }
}

/** Raised when a node or group cannot serve as a generation input. */
export class CanvasInputError extends Error {
  /** @param message - which reference failed and why. */
  constructor(message: string) {
    super(message)
    this.name = 'CanvasInputError'
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false
    throw error
  }
}

/** Owns every project's canvas document. */
export class CanvasService extends TypertRemoteService {
  static inject = ['tools', 'workingDirectory']

  private readonly store = new CanvasStore()

  /** @param ctx - Host context carrying the tool registry and Session directories. */
  constructor(ctx: Context) {
    super(ctx, 'canvas')
    registerCanvasTools(ctx, this)
  }

  /**
   * Project directory whose canvas a Session edits.
   * @param session - Session opened on the project.
   * @returns the Session's original directory, or its current one when the header records none.
   */
  directoryOf(session: Session): string {
    return session.header.cwd ?? this.ctx.workingDirectory.get(session)
  }

  /**
   * Read the canvas of a Session's project.
   * @param session - Session opened on the project.
   * @returns the validated document; an empty canvas when the project has none.
   * @throws `CanvasCorruptError` when the canvas file is not a valid document.
   */
  read(session: Session): Promise<CanvasDocument> {
    return this.store.read(this.directoryOf(session))
  }

  /**
   * Apply operations to the canvas of a Session's project in one write.
   * @param session - Session opened on the project.
   * @param operations - ordered operations; relative media paths resolve against the project directory.
   * @returns assigned ids and the operations that were skipped with their reasons.
   * @throws `CanvasCorruptError` when the canvas file is not a valid document.
   */
  async edit(session: Session, operations: readonly CanvasOperation[]): Promise<CanvasEditResult> {
    const directory = this.directoryOf(session)
    const rejected = new Map<number, string>()
    const prepared = await Promise.all(operations.map(async (operation, index) => {
      if ((operation.op !== 'add' && operation.op !== 'update') || operation.path === undefined) return operation
      const path = isAbsolute(operation.path) ? operation.path : resolve(directory, operation.path)
      if (!await isFile(path)) rejected.set(index, `file ${operation.path} does not exist`)
      return { ...operation, path }
    }))
    const { result, changed } = await this.store.update(directory, (current) => {
      const outcome = applyOperations(current, prepared, rejected)
      return { ...outcome.changed ? { document: outcome.document } : {}, value: outcome }
    })
    if (changed) this.ctx.emit('canvas/change', { directory })
    return result
  }

  /**
   * Resolve nodes and groups to the image files they stand for as generation inputs.
   * @param session - Session opened on the project.
   * @param ids - image node ids or group ids; a group stands for its image members in reading order (top to bottom, then left to right).
   * @returns absolute image paths in input order, without duplicates.
   * @throws {@link CanvasInputError} when an id is unknown, is not an image or group, or is a group without images.
   */
  async resolveImages(session: Session, ids: readonly string[]): Promise<string[]> {
    const document = await this.read(session)
    const paths: string[] = []
    const take = (node: CanvasNode): void => {
      if (node.path !== undefined && !paths.includes(node.path)) paths.push(node.path)
    }
    for (const id of ids) {
      const node = document.nodes.find(candidate => candidate.id === id)
      if (node === undefined) throw new CanvasInputError(`canvas node ${id} does not exist`)
      if (node.type === 'image') {
        take(node)
      } else if (node.type === 'group') {
        const images = document.nodes.filter(member => member.group === id && member.type === 'image')
          .sort((a, b) => a.y - b.y || a.x - b.x)
        if (images.length === 0) throw new CanvasInputError(`canvas group ${id} contains no image`)
        images.forEach(take)
      } else {
        throw new CanvasInputError(`canvas node ${id} is a ${node.type} node, not an image or a group`)
      }
    }
    return paths
  }

  /**
   * Resolve image, video, and audio nodes to their local media files.
   * @param session - Session opened on the project.
   * @param ids - media node ids in the order the caller will consume them.
   * @returns absolute media paths in input order.
   * @throws {@link CanvasInputError} when an id is unknown, is not a media node, or has no path.
   */
  async resolveMedia(session: Session, ids: readonly string[]): Promise<string[]> {
    const document = await this.read(session)
    return ids.map((id) => {
      const node = document.nodes.find(candidate => candidate.id === id)
      if (node === undefined) throw new CanvasInputError(`canvas node ${id} does not exist`)
      if (node.type !== 'image' && node.type !== 'video' && node.type !== 'audio') {
        throw new CanvasInputError(`canvas node ${id} is a ${node.type} node, not a media node`)
      }
      if (node.path === undefined) throw new CanvasInputError(`canvas media node ${id} has no path`)
      return node.path
    })
  }

  /**
   * Read the canvas shown for a Session.
   * @param session - Session opened on the project.
   * @returns the project directory and its canvas document.
   * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
   */
  @Remote('get')
  async get(session: Session): Promise<CanvasView> {
    const directory = this.directoryOf(session)
    return { directory, document: await this.remote(directory, () => this.read(session)) }
  }

  /**
   * Apply a user's edits to the canvas shown for a Session.
   * @param session - Session opened on the project.
   * @param operations - ordered operations.
   * @returns assigned ids and the operations that were skipped with their reasons.
   * @throws RemoteError `canvas/corrupt` when the canvas file is not a valid document.
   */
  @Remote('apply')
  apply(session: Session, operations: CanvasOperation[]): Promise<CanvasEditResult> {
    return this.remote(this.directoryOf(session), () => this.edit(session, operations))
  }

  private async remote<T>(directory: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error: unknown) {
      if (!(error instanceof CanvasCorruptError)) throw error
      throw new RemoteError('canvas/corrupt', error.message, { file: canvasFile(directory), reason: error.reason }, { cause: error })
    }
  }
}

export default CanvasService
