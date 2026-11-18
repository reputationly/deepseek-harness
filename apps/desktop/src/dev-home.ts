/** Development launchers must stay inside scratch roots, never the user's own harness home. */
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'

/**
 * Accept only a scratch harness home for a development run.
 *
 * The desktop shell rewrites the profile patch and the Host reads and writes sessions and
 * credentials, so a development run pointed at a personal home silently changes data its
 * owner never offered to a development build.
 * @param home - resolved DSH_HOME.
 * @returns whether the path lives under a temporary root.
 */
export function isIsolatedDevelopmentHome(home: string): boolean {
  const scratch = [tmpdir(), '/tmp', '/private/tmp'].map(directory => resolve(directory))
  const candidate = resolve(home)
  return scratch.some(directory => candidate === directory || candidate.startsWith(`${directory}${sep}`))
}
