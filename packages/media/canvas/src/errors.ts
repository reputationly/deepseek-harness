/** Raised when an edit was based on a revision the document no longer holds. */
export class CanvasConflictError extends Error {
  /**
   * @param expected - revision the caller read.
   * @param actual - revision currently stored.
   */
  constructor(readonly expected: number, readonly actual: number) {
    super(`canvas revision is ${String(actual)}, not the ${String(expected)} this edit was based on`)
    this.name = 'CanvasConflictError'
  }
}
