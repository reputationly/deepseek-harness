import { existsSync } from 'node:fs'

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly error: string }
export type RewriteResult = { readonly ok: true; readonly args: string[] } | { readonly ok: false; readonly error: string }

export interface FfmpegMetadata {
  readonly prompt?: string
  readonly model?: string
  readonly description?: string
}

const FILTER_OPTIONS = new Set(['-filter_complex', '-vf', '-af', '-filter'])
const FILTER_SCRIPT_OPTIONS = new Set(['-filter_complex_script', '-filter_script', '-/filter_complex', '-/filter'])
const VALUE_OPTIONS = new Set([
  '-i', '-f', '-map', '-c', '-c:v', '-c:a', '-codec:v', '-codec:a', '-vcodec', '-acodec',
  '-crf', '-preset', '-ss', '-to', '-t', '-r', '-s', '-ar', '-ac', '-b:a', '-b:v', '-pix_fmt',
  '-movflags', '-frames:v', '-q:v', '-stream_loop', '-itsoffset', '-metadata', '-threads',
  '-loglevel', '-loop', '-map_metadata', '-map_chapters', '-max_muxing_queue_size', '-fps_mode',
  '-filter_complex', '-vf', '-af', '-filter',
])
const FLAG_OPTIONS = new Set([
  '-an', '-vn', '-sn', '-dn', '-shortest', '-copyts', '-start_at_zero', '-bitexact',
  '-hide_banner', '-nostdin', '-stats', '-stats_period',
])
const PRESERVE_AUDIO = [
  /\b(?:preserve|copy)(?:\s+(?:clip|original|native|source))?\s+audio\b/iu,
  /保留[^。；;，,]{0,16}(?:片段|视频|原生|原始)[^。；;，,]{0,16}音频/u,
  /原样保留[^。；;，,]{0,16}音频/u,
]
const INTENTIONAL_AUDIO_FILTERS = ['amix', 'sidechaincompress', 'loudnorm', 'volume', 'afade', 'atrim', 'adelay', 'compand', 'afftdn']

function optionValues(args: readonly string[], option: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === option) {
      values.push(args[index + 1] as string)
    }
  }
  return values
}

function hasOptionPair(args: readonly string[], option: string, value: string): boolean {
  return args.some((arg, index) => arg === option && args[index + 1] === value)
}

function localInput(source: string, lavfi: boolean): boolean {
  if (lavfi) return true
  if (source === '-' || source.includes('|') || source.startsWith('/dev/') || source.startsWith('\\\\.\\')) return false
  if (/^(?:pipe|fd|concat|subfile|data|crypto|cache|tcp|udp|http|https|rtmp|rtsp|srt):/iu.test(source)) return false
  return !/^[a-z][a-z\d+.-]*:\/\//iu.test(source)
}

function videoConcat(graph: string): boolean {
  return [...graph.matchAll(/concat\s*=\s*([^;,]+)/giu)].some(match => !/\bv\s*=\s*0\b/iu.test(match[1] as string))
}

export function isDryRun(args: readonly string[]): boolean {
  return hasOptionPair(args, '-f', 'null') || args.includes('-f=null')
}

export function checkFfmpegCommand(args: readonly string[], outputType = 'video'): GuardResult {
  const graphs: string[] = []
  let pendingFormat = ''
  let inputCount = 0
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string
    if (arg === '-y' || arg === '-n' || arg.startsWith('-y=') || arg.startsWith('-n=')) {
      return { ok: false, error: 'Do not pass -y or -n; the tool controls output overwrite behavior.' }
    }
    if (FILTER_SCRIPT_OPTIONS.has(arg) || [...FILTER_SCRIPT_OPTIONS].some(option => arg.startsWith(`${option}=`))) {
      return { ok: false, error: 'File-based FFmpeg filter graphs are not supported; pass filter expressions inline.' }
    }
    if (arg.startsWith('-')) {
      const separator = arg.indexOf('=')
      const option = separator === -1 ? arg : arg.slice(0, separator)
      const inline = separator === -1 ? undefined : arg.slice(separator + 1)
      if (FILTER_OPTIONS.has(option)) {
        if (inline !== undefined) return { ok: false, error: `Pass ${option} and its filter expression as separate arguments.` }
        const graph = args[++index]
        if (graph === undefined || graph.startsWith('-')) return { ok: false, error: `Missing filter expression after ${option}.` }
        graphs.push(graph)
        continue
      }
      if (option === '-i') {
        const source = inline ?? args[++index]
        if (source === undefined || source.startsWith('-')) return { ok: false, error: 'Missing input path after -i.' }
        if (!localInput(source, pendingFormat === 'lavfi')) return { ok: false, error: `Only local input files are allowed: ${source}` }
        inputCount++
        pendingFormat = ''
        continue
      }
      if (option === '-f') {
        const format = inline ?? args[++index]
        if (format === undefined || format.startsWith('-')) return { ok: false, error: 'Missing format after -f.' }
        if (format !== 'null' && format !== 'lavfi') return { ok: false, error: `Unsupported FFmpeg format: ${format}. Only lavfi inputs and null dry runs are allowed.` }
        if (format === 'lavfi') pendingFormat = format
        continue
      }
      if (VALUE_OPTIONS.has(option)) {
        const value = inline ?? args[++index]
        if (value === undefined || (inline === undefined && value.startsWith('-'))) return { ok: false, error: `Missing value after ${option}.` }
        continue
      }
      if (FLAG_OPTIONS.has(option)) continue
      return { ok: false, error: `Unsupported FFmpeg option: ${option}` }
    }
    return { ok: false, error: `Extra output path or unexpected argument is not allowed: ${arg}` }
  }
  if (pendingFormat === 'lavfi') return { ok: false, error: '-f lavfi must be followed by an input introduced with -i.' }
  if (inputCount === 0) return { ok: false, error: 'At least one local input or lavfi source is required.' }
  if (outputType === 'video' && graphs.some(videoConcat)) {
    return { ok: false, error: 'Video concatenation must use merge_videos so streams can be normalized safely.' }
  }
  return { ok: true }
}

export function checkFfmpegAudioPreserve(args: readonly string[], metadata?: FfmpegMetadata, outputType = 'video'): GuardResult {
  const command = checkFfmpegCommand(args, outputType)
  if (!command.ok || isDryRun(args)) return command
  const text = [metadata?.description, metadata?.prompt, metadata?.model].filter(Boolean).join('\n')
  if (!PRESERVE_AUDIO.some(pattern => pattern.test(text)) || optionValues(args, '-i').length < 2) return { ok: true }
  const graphs = [...optionValues(args, '-filter_complex'), ...optionValues(args, '-vf'), ...optionValues(args, '-af')]
  const intentional = graphs.some(graph => INTENTIONAL_AUDIO_FILTERS.some(filter => graph.includes(filter)))
  const risky = graphs.some(graph =>
    /concat\s*=\s*n\s*=\s*\d+[^;]*:a\s*=\s*1/iu.test(graph)
      && /\[\d+:a\][^;]*(?:aresample|aformat=)/iu.test(graph))
  const mapsFilteredAudio = optionValues(args, '-map').some(value => /^\[[^\]]*a[^\]]*\]$/iu.test(value))
  return risky && mapsFilteredAudio && !intentional
    ? { ok: false, error: 'This command re-encodes filtered audio despite saying the source audio should be preserved. Use merge_videos for ordered clips, or describe the intentional audio change.' }
    : { ok: true }
}

export function isPureAudioReplacementMux(args: readonly string[], outputType: string): boolean {
  const inputs = optionValues(args, '-i')
  const maps = optionValues(args, '-map')
  const mappedAudio = maps.some(value => /^1:a(?::0)?\??$/u.test(value))
  const mappedVideo = maps.some(value => /^0:v(?::0)?\??$/u.test(value))
  const secondIsAudio = /\.(?:aac|flac|m4a|mp3|ogg|opus|wav)$/iu.test(inputs[1] ?? '')
  const copiesVideo = ['-c:v', '-codec:v', '-vcodec'].some(option => hasOptionPair(args, option, 'copy'))
  return outputType === 'video' && inputs.length === 2 && copiesVideo && (mappedVideo && mappedAudio || secondIsAudio)
}

export function extractOptionValues(filter: string, key: string): string[] {
  const values: string[] = []
  const needle = `${key}=`
  let searchFrom = 0
  let index = filter.indexOf(needle, searchFrom)
  while (index !== -1) {
    const preceding = filter[index - 1]
    if (preceding !== undefined && /[a-z\d_]/iu.test(preceding)) {
      searchFrom = index + needle.length
      index = filter.indexOf(needle, searchFrom)
      continue
    }
    let cursor = index + needle.length
    const quote = filter[cursor]
    let value = ''
    if (quote === "'" || quote === '"') {
      cursor++
      while (cursor < filter.length && filter[cursor] !== quote) {
        if (filter[cursor] === '\\' && cursor + 1 < filter.length) {
          value += filter.slice(cursor, cursor + 2)
          cursor += 2
        } else {
          value += filter[cursor] as string
          cursor++
        }
      }
    } else {
      while (cursor < filter.length && ![':', ',', ']'].includes(filter[cursor] as string)) {
        if (filter[cursor] === '\\' && cursor + 1 < filter.length) {
          value += filter.slice(cursor, cursor + 2)
          cursor += 2
        } else {
          value += filter[cursor] as string
          cursor++
        }
      }
    }
    values.push(value)
    searchFrom = cursor
    index = filter.indexOf(needle, searchFrom)
  }
  return values
}

export function escapeFfmpegFilterValue(value: string): string {
  return value.replace(/[\\:']/gu, character => `\\${character}`)
}

function drawtextRanges(filter: string): { readonly start: number; readonly end: number }[] {
  const ranges: { start: number; end: number }[] = []
  let start = filter.indexOf('drawtext=')
  while (start !== -1) {
    let end = start
    let quote = ''
    while (end < filter.length) {
      const character = filter.charAt(end)
      if (character === '\\') end += 2
      else if (quote !== '') {
        if (character === quote) quote = ''
        end++
      } else if (character === "'" || character === '"') {
        quote = character
        end++
      } else if ([',', ';', '['].includes(character)) break
      else end++
    }
    ranges.push({ start, end })
    start = filter.indexOf('drawtext=', end)
  }
  return ranges
}

export function injectCjkFont(
  args: readonly string[],
  fontPath?: string,
  fileExists: (path: string) => boolean = existsSync,
): RewriteResult {
  const output = [...args]
  for (let index = 0; index < output.length; index++) {
    const arg = output[index] as string
    if (!arg.includes('drawtext')) continue
    let rewritten = arg
    for (const range of drawtextRanges(arg).reverse()) {
      const expression = arg.slice(range.start, range.end)
      if (!extractOptionValues(expression, 'text').some(text => /[^\x00-\x7f]/u.test(text))) continue
      if (['fontfile', 'font'].some(key => extractOptionValues(expression, key).some(value => value.trim() !== ''))) continue
      if (fontPath === undefined) return { ok: false, error: 'Non-ASCII drawtext needs a configured fontFile; set an absolute font path and retry.' }
      if (!fileExists(fontPath)) return { ok: false, error: `Configured fontFile does not exist: ${fontPath}` }
      const injected = expression.replace('drawtext=', `drawtext=fontfile='${escapeFfmpegFilterValue(fontPath)}':`)
      rewritten = `${rewritten.slice(0, range.start)}${injected}${rewritten.slice(range.end)}`
    }
    output[index] = rewritten
  }
  return { ok: true, args: output }
}

export function checkFfmpegDrawtext(args: readonly string[], fileExists: (path: string) => boolean = existsSync): GuardResult {
  for (const arg of args) {
    if (arg.includes('drawtext') && extractOptionValues(arg, 'text').some(text => /\\+n/u.test(text))) {
      return { ok: false, error: 'drawtext does not interpret \\\\n as a line break; use textfile with real newlines or separate drawtext filters.' }
    }
    for (const rawPath of extractOptionValues(arg, 'fontfile')) {
      const path = rawPath.replace(/\\(.)/gu, '$1').trim()
      if (path !== '' && !fileExists(path)) return { ok: false, error: `ffmpeg drawtext fontfile does not exist: ${path}` }
    }
  }
  return { ok: true }
}
