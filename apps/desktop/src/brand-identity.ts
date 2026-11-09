/** Product-owned Harness roots and link scheme, kept apart from any dsh installed on the same machine. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENTS_HOME_ENV, DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'

/** Harness roots the product owns. */
export interface BrandHome { readonly dshHome: string; readonly agentsHome: string }

/**
 * Point this process, and every Host it spawns, at the product's own Harness roots.
 * Packaged builds ignore an inherited DSH_HOME or DSH_AGENTS_HOME, which belongs to the user's own dsh;
 * unpackaged runs keep one so development launchers and fixtures stay isolated.
 * @param environment - main-process environment, changed before any Harness path resolves.
 * @param packaged - whether the running application is packaged.
 * @param home - operating-system home directory.
 * @returns the roots written, or undefined when the build inlined no product home.
 */
export function isolateBrandHome(environment: NodeJS.ProcessEnv, packaged: boolean, home: string = homedir()): BrandHome | undefined {
  const name = process.env.DSH_BRAND_HOME_DIR
  if (name === undefined || name === '') return undefined
  const inherited = (key: string): string | undefined => {
    const value = packaged ? undefined : environment[key]
    return value === undefined || value.trim() === '' ? undefined : value
  }
  const dshHome = inherited(DSH_HOME_ENV) ?? join(home, name)
  const agentsHome = inherited(AGENTS_HOME_ENV) ?? join(dshHome, 'agents')
  environment[DSH_HOME_ENV] = dshHome
  environment[AGENTS_HOME_ENV] = agentsHome
  return { dshHome, agentsHome }
}

/** @returns the URL scheme the product registers with the operating system. */
export function brandUrlScheme(): string {
  const scheme = process.env.DSH_BRAND_URL_SCHEME
  return scheme === undefined || scheme === '' ? 'dsh' : scheme
}
