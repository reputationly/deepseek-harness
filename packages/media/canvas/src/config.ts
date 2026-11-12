/**
 * Deployment-tunable bounds of one canvas.
 * @module @deepseek-ai/dsh-canvas/config
 */

import z from '@deepseek-ai/schemastery'

/** Bounds a deployment may change; protocol constants stay in the code that enforces them. */
export interface Config {
  /** Largest number of nodes one canvas may hold, groups included. */
  maxNodes?: number
  /** Largest number of edges one canvas may hold. */
  maxEdges?: number
  /** Longest prompt accepted on one node, in characters. */
  maxPromptLength?: number
  /** Largest number of operations one `canvas_edit` call may carry. */
  maxBatchOperations?: number
  /** Versions kept per media node; the active version is never evicted. */
  versionLimit?: number
  /** Versions kept per text, script, and storyboard node. */
  textVersionLimit?: number
  /** Largest number of shots one storyboard table may hold. */
  maxShotsPerStoryboard?: number
  /** Edits kept in the undo journal of one episode. */
  journalLimit?: number
}

/** Bounds with deployment defaults applied. */
export type ResolvedConfig = Required<Config>

/** Config schema whose defaults are the deployment defaults. */
export const Config: z<Config> = z.object({
  maxNodes: z.number().default(10000),
  maxEdges: z.number().default(20000),
  maxPromptLength: z.number().default(20000),
  maxBatchOperations: z.number().default(64),
  versionLimit: z.number().default(8),
  textVersionLimit: z.number().default(20),
  maxShotsPerStoryboard: z.number().default(24),
  journalLimit: z.number().default(200),
})

/**
 * Apply the defaults and reject bounds that cannot bound anything.
 * @param config - deployment config.
 * @returns the config with every field present.
 * @throws Error naming the field whose value is not a positive integer.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    maxNodes: config.maxNodes ?? 10000,
    maxEdges: config.maxEdges ?? 20000,
    maxPromptLength: config.maxPromptLength ?? 20000,
    maxBatchOperations: config.maxBatchOperations ?? 64,
    versionLimit: config.versionLimit ?? 8,
    textVersionLimit: config.textVersionLimit ?? 20,
    maxShotsPerStoryboard: config.maxShotsPerStoryboard ?? 24,
    journalLimit: config.journalLimit ?? 200,
  }
  for (const [field, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`canvas Config ${field} must be a positive integer`)
  }
  return resolved
}
