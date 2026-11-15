/** Local media paths and references, including Windows drive paths and file URLs. */
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A drive prefix is a filesystem path, even though its colon also resembles a URI scheme.
 * @param source - file path or URI.
 * @returns the URI scheme, excluding Windows drive prefixes.
 */
export function mediaProtocol(source: string): string | undefined {
  if (/^[a-z]:/iu.test(source)) return undefined
  return /^([a-z][a-z\d+.-]*):/iu.exec(source)?.[1]?.toLowerCase()
}

/**
 * Decode a file URL and reject network protocols where the caller expects a local file.
 * @param source - file path or file URI.
 * @returns the local file path.
 */
export function localMediaPath(source: string): string {
  const protocol = mediaProtocol(source)
  if (protocol === undefined) return source
  if (protocol === 'file') return fileURLToPath(source)
  throw new Error(`Only local input files are allowed (${protocol}:)`)
}

/**
 * Encode local voice samples; only HTTP(S) and data references are sent to the gateway unchanged.
 * @param source - voice sample path or supported reference URI.
 * @returns a data URI for local files, or the supplied HTTP(S)/data reference.
 */
export async function voiceReference(source: string): Promise<string> {
  const protocol = mediaProtocol(source)
  if (protocol === 'http' || protocol === 'https' || protocol === 'data') return source
  const path = localMediaPath(source)
  const type = ({ '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' } as Readonly<Record<string, string>>)[extname(path).toLowerCase()] ?? 'audio/wav'
  return `data:${type};base64,${(await readFile(path)).toString('base64')}`
}
