/**
 * Report how much this fork diverges from upstream, split by whether a path is
 * upstream-owned or fork-only, because only the upstream-owned half costs
 * anything at the next alignment.
 *
 * Two surfaces need the same number. An alignment starts by measuring the drift
 * it must carry, and a review asks whether a change added new upstream-owned
 * edits that could instead live in a fork-only package. Upstream-owned paths are
 * ranked by how many upstream commits touched them since the merge base, which
 * is the per-file conflict risk.
 *
 * The baseline records the totals this repository accepts. `--check` fails when
 * the current totals exceed them, so drift cannot grow unnoticed between
 * alignments; `--write-baseline` records a reviewed state after an alignment.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './release/process.ts'

/** The three ways a path in the fork's diff relates to upstream. */
type PathClass = 'upstream-owned' | 'fork-only' | 'removed-upstream'

/** One path the fork changed, with its line delta and upstream conflict risk. */
interface DriftRow {
  readonly path: string
  readonly pathClass: PathClass
  readonly added: number
  readonly removed: number
  /** Upstream commits since the merge base that touch this path; 0 for fork-only paths. */
  readonly upstreamCommits: number
}

/** Totals a baseline records and `--check` compares. */
interface DriftTotals {
  readonly upstreamOwnedFiles: number
  readonly upstreamOwnedAdded: number
  readonly upstreamOwnedRemoved: number
  readonly forkOnlyFiles: number
  readonly forkOnlyAdded: number
  readonly removedUpstreamFiles: number
}

/** The recorded drift this repository accepts between alignments. */
interface DriftBaseline {
  readonly note: string
  readonly measuredAt: string
  readonly forkRef: string
  readonly upstreamRef: string
  readonly mergeBase: string
  readonly totals: DriftTotals
  /** Ceilings `--check` enforces; a total above its ceiling fails the run. */
  readonly thresholds: Omit<DriftTotals, 'forkOnlyFiles' | 'forkOnlyAdded' | 'removedUpstreamFiles'>
}

/** Command-line inputs after validation. */
interface Options {
  readonly forkRef: string
  readonly upstreamRef: string
  readonly baselinePath: string
  readonly limit: number
  readonly check: boolean
  readonly writeBaseline: boolean
  readonly json: boolean
}

/** Byte ceiling for one git command; the path listings of this repository exceed Node's default. */
const MAX_GIT_OUTPUT_BYTES = 512 * 1024 * 1024

/** Default refs and baseline location, relative to the repository root. */
const DEFAULTS = { forkRef: 'master', upstreamRef: 'upstream/master', baselinePath: 'scripts/fork-drift.baseline.json', limit: 15 } as const

/**
 * Read one string option.
 * @param value - parsed option value.
 * @param name - option name, used in the failure message.
 * @param fallback - value used when the option is absent.
 * @returns The option value.
 */
function textOption(value: string | undefined, name: string, fallback: string): string {
  if (value === undefined) return fallback
  if (value === '') throw new Error(`--${name} expects a non-empty value`)
  return value
}

/**
 * Read a positive integer option.
 * @param value - raw option value.
 * @param name - option name, used in the failure message.
 * @param fallback - value used when the option is absent.
 * @returns The validated integer.
 */
function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} expects a positive integer, got ${value}`)
  return parsed
}

/**
 * Parse and validate the command line.
 * @returns Validated options, with unknown options rejected by the parser.
 */
function options(): Options {
  const { values } = parseArgs({
    options: {
      fork: { type: 'string' },
      upstream: { type: 'string' },
      baseline: { type: 'string' },
      limit: { type: 'string' },
      check: { type: 'boolean', default: false },
      'write-baseline': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  })
  return {
    forkRef: textOption(values.fork, 'fork', DEFAULTS.forkRef),
    upstreamRef: textOption(values.upstream, 'upstream', DEFAULTS.upstreamRef),
    baselinePath: textOption(values.baseline, 'baseline', DEFAULTS.baselinePath),
    limit: positiveInteger(values.limit, 'limit', DEFAULTS.limit),
    check: values.check,
    writeBaseline: values['write-baseline'],
    json: values.json,
  }
}

/**
 * Run git and return its trimmed standard output.
 * @param args - git arguments.
 * @param repoRoot - repository working directory; the current one when omitted.
 * @returns The trimmed output.
 */
function git(args: readonly string[], repoRoot?: string): string {
  const result = spawnSync('git', [...args], {
    ...repoRoot === undefined ? {} : { cwd: repoRoot },
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited with ${String(result.status)}:\n${result.stderr}`)
  return result.stdout.trim()
}

/**
 * Resolve the repository root containing the current working directory.
 * @returns The absolute repository root.
 */
function repositoryRoot(): string {
  return git(['rev-parse', '--show-toplevel'])
}

/**
 * List every tracked path of one revision.
 * @param repoRoot - repository working directory.
 * @param revision - revision to list.
 * @returns The path set.
 */
function pathsOf(repoRoot: string, revision: string): Set<string> {
  const output = git(['ls-tree', '-r', '--name-only', revision], repoRoot)
  return new Set(output === '' ? [] : output.split('\n'))
}

/**
 * Read the per-path line delta of the fork's changes against the merge base.
 * @param repoRoot - repository working directory.
 * @param base - merge base revision.
 * @param forkRef - fork revision.
 * @returns Added and removed line counts per path, with `-` counted as zero.
 */
function lineDeltas(repoRoot: string, base: string, forkRef: string): Map<string, { added: number; removed: number }> {
  const output = git(['diff', '--numstat', '--no-renames', `${base}..${forkRef}`], repoRoot)
  const deltas = new Map<string, { added: number; removed: number }>()
  for (const line of output === '' ? [] : output.split('\n')) {
    const [added, removed, ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (path === '') continue
    deltas.set(path, { added: Number(added === '-' ? 0 : added), removed: Number(removed === '-' ? 0 : removed) })
  }
  return deltas
}

/**
 * Count, for every path, how many upstream commits since the merge base touched it.
 *
 * One `git log` walk replaces one `git rev-list` call per path; merge commits
 * contribute no paths by default, matching a per-path revision count.
 * @param repoRoot - repository working directory.
 * @param base - merge base revision.
 * @param upstreamRef - upstream revision.
 * @returns Commit counts per path.
 */
function upstreamCommitCounts(repoRoot: string, base: string, upstreamRef: string): Map<string, number> {
  const output = git(['log', '--format=%x1e', '--name-only', `${base}..${upstreamRef}`], repoRoot)
  const counts = new Map<string, number>()
  for (const line of output === '' ? [] : output.split('\n')) {
    if (line === '' || line === '\u001e') continue
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return counts
}

/**
 * Classify every changed path and attach its risk.
 * @param inputs - the path sets, line deltas, and upstream commit counts.
 * @returns One row per changed path.
 */
function classify(inputs: {
  readonly upstreamPaths: ReadonlySet<string>
  readonly forkPaths: ReadonlySet<string>
  readonly basePaths: ReadonlySet<string>
  readonly deltas: ReadonlyMap<string, { added: number; removed: number }>
  readonly upstreamCommits: ReadonlyMap<string, number>
}): DriftRow[] {
  const result: DriftRow[] = []
  for (const [path, delta] of inputs.deltas) {
    const upstreamOwned = inputs.upstreamPaths.has(path)
    const forkHasIt = inputs.forkPaths.has(path)
    const baseHadIt = inputs.basePaths.has(path)
    const pathClass: PathClass = upstreamOwned
      ? 'upstream-owned'
      : !forkHasIt && baseHadIt ? 'removed-upstream' : 'fork-only'
    result.push({
      path,
      pathClass,
      added: delta.added,
      removed: delta.removed,
      upstreamCommits: pathClass === 'upstream-owned' ? inputs.upstreamCommits.get(path) ?? 0 : 0,
    })
  }
  return result.sort((left, right) =>
    right.upstreamCommits - left.upstreamCommits
    || right.added - left.added
    || left.path.localeCompare(right.path))
}

/**
 * Sum the rows into the totals a baseline compares.
 * @param rows - classified drift rows.
 * @returns The totals.
 */
function totalsOf(rows: readonly DriftRow[]): DriftTotals {
  const totals = {
    upstreamOwnedFiles: 0,
    upstreamOwnedAdded: 0,
    upstreamOwnedRemoved: 0,
    forkOnlyFiles: 0,
    forkOnlyAdded: 0,
    removedUpstreamFiles: 0,
  }
  for (const row of rows) {
    if (row.pathClass === 'upstream-owned') {
      totals.upstreamOwnedFiles += 1
      totals.upstreamOwnedAdded += row.added
      totals.upstreamOwnedRemoved += row.removed
    } else if (row.pathClass === 'fork-only') {
      totals.forkOnlyFiles += 1
      totals.forkOnlyAdded += row.added
    } else {
      totals.removedUpstreamFiles += 1
    }
  }
  return totals
}

/**
 * Read the recorded baseline.
 * @param repoRoot - repository working directory.
 * @param baselinePath - baseline path relative to the repository root.
 * @returns The baseline, or undefined when the file does not exist yet.
 */
function readBaseline(repoRoot: string, baselinePath: string): DriftBaseline | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, baselinePath), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`${baselinePath} must hold a JSON object`)
    return parsed as DriftBaseline
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Compare current totals with the baseline ceilings.
 * @param current - measured totals.
 * @param baseline - recorded baseline.
 * @returns Human-readable failures; empty when every total is within its ceiling.
 */
function ceilingFailures(current: DriftTotals, baseline: DriftBaseline): string[] {
  const failures: string[] = []
  for (const [name, ceiling] of Object.entries(baseline.thresholds)) {
    const measured = current[name as keyof DriftTotals]
    if (measured > ceiling) failures.push(`${name}: ${String(measured)} exceeds ${String(ceiling)}`)
  }
  return failures
}

/**
 * Print the human-readable report.
 * @param rows - classified drift rows.
 * @param totals - aggregated totals.
 * @param context - resolved refs and merge base.
 * @param limit - how many upstream-owned rows to list.
 */
function report(
  rows: readonly DriftRow[],
  totals: DriftTotals,
  context: { base: string; forkRef: string; upstreamRef: string },
  limit: number,
): void {
  const line = (label: string, value: string): void => { process.stdout.write(`${label.padEnd(34)}${value}\n`) }
  line('merge base', context.base.slice(0, 12))
  line('fork / upstream', `${context.forkRef} / ${context.upstreamRef}`)
  line('upstream-owned files (merge cost)', String(totals.upstreamOwnedFiles))
  line('  lines added / removed', `+${String(totals.upstreamOwnedAdded)} / -${String(totals.upstreamOwnedRemoved)}`)
  line('fork-only files (no merge cost)', String(totals.forkOnlyFiles))
  line('  lines added', `+${String(totals.forkOnlyAdded)}`)
  line('upstream files the fork deleted', String(totals.removedUpstreamFiles))
  const owned = rows.filter(row => row.pathClass === 'upstream-owned')
  process.stdout.write('\nhighest conflict risk (upstream commits since merge base):\n')
  for (const row of owned.slice(0, limit)) {
    process.stdout.write(`  ${String(row.upstreamCommits).padStart(2)}x  +${String(row.added).padStart(4)}/-${String(row.removed).padStart(4)}  ${row.path}\n`)
  }
}

/**
 * Run the report, the baseline write, or the ceiling check.
 */
function main(): void {
  const options_ = options()
  const repoRoot = repositoryRoot()
  const base = git(['merge-base', options_.forkRef, options_.upstreamRef], repoRoot)
  const deltas = lineDeltas(repoRoot, base, options_.forkRef)
  const rowList = classify({
    upstreamPaths: pathsOf(repoRoot, options_.upstreamRef),
    forkPaths: pathsOf(repoRoot, options_.forkRef),
    basePaths: pathsOf(repoRoot, base),
    deltas,
    upstreamCommits: upstreamCommitCounts(repoRoot, base, options_.upstreamRef),
  })
  const totals = totalsOf(rowList)
  const context = { base, forkRef: options_.forkRef, upstreamRef: options_.upstreamRef }

  if (options_.json) {
    process.stdout.write(`${JSON.stringify({ ...context, totals, rows: rowList }, undefined, 2)}\n`)
  } else {
    report(rowList, totals, context, options_.limit)
  }

  if (options_.writeBaseline) {
    const baseline: DriftBaseline = {
      note: 'Fork drift ceilings recorded after an alignment review. --write-baseline resets them to the measured totals; see .agents/skills/dsh-fork-align-upstream.',
      measuredAt: new Date().toISOString(),
      forkRef: context.forkRef,
      upstreamRef: context.upstreamRef,
      mergeBase: context.base,
      totals,
      thresholds: {
        upstreamOwnedFiles: totals.upstreamOwnedFiles,
        upstreamOwnedAdded: totals.upstreamOwnedAdded,
        upstreamOwnedRemoved: totals.upstreamOwnedRemoved,
      },
    }
    writeFileSync(join(repoRoot, options_.baselinePath), `${JSON.stringify(baseline, undefined, 2)}\n`)
    process.stdout.write(`\nwrote ${options_.baselinePath}\n`)
  }

  if (!options_.check) return
  const baseline = readBaseline(repoRoot, options_.baselinePath)
  if (baseline === undefined) throw new Error(`no baseline at ${options_.baselinePath}; run with --write-baseline after an alignment review`)
  const failures = ceilingFailures(totals, baseline)
  if (failures.length === 0) {
    process.stdout.write('\ndrift is within the recorded ceilings\n')
    return
  }
  process.stderr.write(`\ndrift exceeds the recorded ceilings:\n${failures.map(failure => `  ${failure}\n`).join('')}`)
  process.exitCode = 1
}

if (isEntry(import.meta.url)) main()
