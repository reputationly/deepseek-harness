/** Framework-free merge of one gateway listing into the model route's catalog. */
import type { CatalogEntry, CatalogSyncFailure, ModelSyncResult } from './types.ts'

/** Inputs of one catalog refresh. */
export interface CatalogSyncInputs {
  /** Origin of the gateway this deployment routes through. */
  readonly origin: string
  /** Listing path on that origin, such as `/v1/models`. */
  readonly modelsPath: string
  /** Request budget of one listing. */
  readonly timeoutMs: number
  /** Transport used for the listing; injectable so tests own their bytes. */
  readonly send: typeof fetch
  /** Endpoint types a row may declare to join the catalog; empty admits every row. */
  readonly endpointTypes: readonly string[]
  /**
   * Resolve the gateway key.
   * @returns the key, or `undefined` when this deployment stores none.
   */
  readonly credential: () => Promise<string | undefined>
  /**
   * Catalog entries currently in effect.
   * @returns the entries the route offers now.
   */
  readonly current: () => readonly CatalogEntry[]
  /**
   * Replace the catalog.
   * @param models - entries to put in effect.
   */
  readonly write: (models: readonly CatalogEntry[]) => Promise<void>
}

/** Endpoint types one row declares, or `undefined` when it declares none. */
function rowEndpointTypes(row: unknown): readonly string[] | undefined {
  if (typeof row !== 'object' || row === null) return undefined
  const declared = (row as { supported_endpoint_types?: unknown }).supported_endpoint_types
  if (!Array.isArray(declared)) return undefined
  return declared.filter((kind: unknown): kind is string => typeof kind === 'string')
}

/** Ids a listing answered with, in listing order and without repeats, restricted to the endpoint types asked for. */
function listedIds(payload: unknown, endpointTypes: readonly string[]): string[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  const ids: string[] = []
  for (const row of data as unknown[]) {
    if (typeof row !== 'object' || row === null) continue
    const id = (row as { id?: unknown }).id
    if (typeof id !== 'string' || id === '' || ids.includes(id)) continue
    if (endpointTypes.length > 0) {
      const declared = rowEndpointTypes(row)
      if (declared !== undefined && !declared.some(kind => endpointTypes.includes(kind))) continue
    }
    ids.push(id)
  }
  return ids
}

/**
 * Merge a gateway listing into the catalog: the listing decides membership and order, while
 * an entry the deployment already knew keeps the facts a listing rarely repeats.
 * @param ids - ids the gateway listed, in order.
 * @param current - entries in effect before the refresh.
 * @returns the merged catalog.
 */
export function mergeCatalog(ids: readonly string[], current: readonly CatalogEntry[]): CatalogEntry[] {
  const known = new Map(current.map(entry => [entry.id, entry]))
  return ids.map((id) => {
    const previous = known.get(id)
    return previous === undefined ? { id } : previous
  })
}

/**
 * Fetch the gateway listing and put it in effect.
 *
 * A listing that fails never clears the catalog: the route keeps serving what it had, and the
 * caller reports why. An empty listing counts as a failure for the same reason.
 */
export class CatalogSync {
  constructor(private readonly inputs: CatalogSyncInputs) {}

  /**
   * Refresh the catalog from the gateway.
   * @returns how the catalog changed, or why it stayed as it was.
   */
  async refresh(): Promise<ModelSyncResult> {
    const previous = this.inputs.current()
    const keep = (reason: CatalogSyncFailure): ModelSyncResult => ({ ok: false, reason, kept: previous.length })
    const key = await this.inputs.credential()
    if (key === undefined || key === '') return keep('no-credential')
    const url = new URL(this.inputs.modelsPath, this.inputs.origin).href
    let response: Response
    try {
      response = await this.inputs.send(url, {
        headers: { authorization: `Bearer ${key}`, 'x-api-key': key, accept: 'application/json' },
        signal: AbortSignal.timeout(this.inputs.timeoutMs),
      })
    } catch {
      return keep('unreachable')
    }
    if (response.status === 401 || response.status === 403) return keep('unauthorized')
    if (!response.ok) return keep('unreachable')
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return keep('unreachable')
    }
    const ids = listedIds(payload, this.inputs.endpointTypes)
    if (ids === undefined) return keep('unreachable')
    if (ids.length === 0) return keep('empty-listing')
    const models = mergeCatalog(ids, previous)
    const before = previous.map(entry => entry.id).join('\n')
    const changed = before !== models.map(entry => entry.id).join('\n')
    if (changed) await this.inputs.write(models)
    return {
      ok: true,
      count: models.length,
      added: models.filter(model => !previous.some(entry => entry.id === model.id)).length,
      removed: previous.filter(entry => !models.some(model => model.id === entry.id)).length,
      changed,
    }
  }
}
