/**
 * Remove credentials from values that leave the machine inside a feedback snapshot.
 *
 * The feedback site stores what it receives, so a key pasted into a conversation must
 * not reach it. Keys and property names that name a credential are replaced before the
 * snapshot is measured or serialized; the server's own pattern matching is a fallback,
 * not the guarantee.
 *
 * @module @deepseek-ai/dsh-assistant-feedback/redact
 */

/** What replaces a removed credential in text. */
const MASK = '***'

/** Free-text rules, applied in order; each keeps the label that identified the value. */
const TEXT_RULES: readonly (readonly [RegExp, string])[] = [
  // A header whose value is a credential: the whole remainder of the line is replaced, so a
  // value written as `Bearer …` loses its prefix too.
  [/\b(authorization)[^\S\n]*([:=][^\S\n]*)[^\n]*/giu, `$1$2${MASK}`],
  // `key: value` and `key=value` forms whose label names a credential.
  [/\b(api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|password|passwd|token)[^\S\n]*([:=][^\S\n]*)\S+/giu, `$1$2${MASK}`],
  // A bare provider key, without a label that already named it.
  [/\bsk-[A-Za-z0-9_-]{6,}/gu, `sk-${MASK}`],
  // An authorization scheme without its header name.
  [/\b(Bearer)\s+\S+/giu, `$1 ${MASK}`],
  // Cookie pairs and whole headers.
  [/\b(Cookie|Set-Cookie)[^\S\n]*:[^\n]*/giu, `$1: ${MASK}`],
]

/** Property names whose value is a credential whatever it looks like. */
const SECRET_KEY_NAMES = [
  'authorization', 'api[-_]?key', 'access[-_]?key', 'secret[-_]?key', 'client[-_]?secret',
  'password', 'passwd', 'token', 'cookie', 'set-cookie', 'session[-_]?token',
]

/** One case-insensitive matcher over the credential property names. */
const SECRET_KEYS = new RegExp(`^(?:${SECRET_KEY_NAMES.join('|')})$`, 'iu')

/**
 * Replace credentials inside free text.
 * @param text - text that may carry a key, header, or password.
 * @returns the text with every matched credential masked.
 */
export function redactText(text: string): string {
  let result = text
  for (const [pattern, replacement] of TEXT_RULES) result = result.replace(pattern, replacement)
  return result
}

/**
 * Whether a property name names a credential.
 * @param key - property name to test.
 * @returns true when the whole value must be masked.
 */
export function isSecretKey(key: string): boolean {
  return SECRET_KEYS.test(key)
}

/**
 * Mask credentials in a JSON-compatible value.
 *
 * Object properties whose name names a credential are masked whole; every other string
 * is passed through {@link redactText}. Values that cannot be serialized are dropped.
 * @param value - value from a snapshot source.
 * @returns a detached copy safe to attach to a submission.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(item => redactValue(item))
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = isSecretKey(key) ? MASK : redactValue(item)
    }
    return result
  }
  return value
}
