/** Resolve music and speech parameters before preparation or paid submission. */
import { capabilitiesFor, type MediaCatalog } from './catalog.ts'
import { MediaGatewayError } from './gateway.ts'

type Params = Readonly<Record<string, string | number | boolean>>

/** Why an audio request cannot be submitted without a user edit or catalog update. */
export type AudioPlanFailure = 'model_unavailable' | 'unsupported_transport' | 'unsupported_mode' | 'missing_input' | 'invalid_range' | 'unsupported_reference'

/** A request rejected before submission; changing inputs or gateway configuration permits a new attempt. */
export class AudioPlanError extends MediaGatewayError {
  /**
   * @param code - stable failure identity for callers.
   * @param message - correction the requesting user or Agent can make.
   */
  constructor(readonly code: AudioPlanFailure, message: string) {
    super(message, 400)
    this.name = 'AudioPlanError'
  }
}

/** Request fields read from the current node and its resolved audio edges. */
export interface AudioPlanInput {
  readonly kind: 'music' | 'speech'
  readonly model: string
  readonly prompt: string
  readonly params: Params
  readonly catalog?: MediaCatalog
  readonly audioReferences?: readonly string[]
}

/** Fully resolved request; raw reference paths are materialized before submission. */
export type AudioPlan = {
  readonly model: string
  readonly prompt: string
  readonly params: Params
  readonly reference?: { readonly field: 'voice' | 'reference_audio' | 'src_audio'; readonly value: string }
} & (
  | { readonly transport: 'videos_task'; readonly metadata: Params }
  | { readonly transport: 'audio_speech'; readonly instructions?: string }
)

function selected(params: Params, keys: readonly string[]): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {}
  for (const key of keys) {
    const value = params[key]
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) continue
    output[key] = value
  }
  return output
}

function text(params: Params, key: string): string {
  return typeof params[key] === 'string' ? params[key].trim() : ''
}

/**
 * Resolve model semantics and reject unavailable modes before a paid attempt begins.
 * @param input - current node values, reference files, and the key's capability catalog.
 * @returns a task or speech request with effective parameters for version recording.
 * @throws AudioPlanError when inputs or the gateway catalog require correction; no request is sent.
 */
export function resolveAudioPlan(input: AudioPlanInput): AudioPlan {
  const { model, kind, params, catalog } = input
  const operation = kind === 'music' ? 'generate_music' : 'generate_speech'
  const capability = catalog === undefined ? undefined : capabilitiesFor(catalog, operation).find(entry => entry.model === model)
  if (catalog !== undefined && capability === undefined) {
    throw new AudioPlanError('model_unavailable', `Audio model ${model} is absent from this key's capability catalog; refresh the catalog or choose an offered model`)
  }
  const transport = capability?.transport?.kind ?? (kind === 'music' ? 'videos_task' : 'audio_speech')
  if (transport !== 'videos_task' && transport !== 'audio_speech') {
    throw new AudioPlanError('unsupported_transport', `Audio model ${model} declares unsupported transport ${transport}`)
  }
  if (kind === 'music' && transport !== 'videos_task') throw new AudioPlanError('unsupported_transport', `Music model ${model} needs the task transport`)
  const reference = input.audioReferences?.[0]
  if ((input.audioReferences?.length ?? 0) > 1) throw new AudioPlanError('unsupported_reference', 'Choose one source audio version for this request')
  if (kind === 'speech') {
    if (text(params, 'task_type') !== '' && params.task_type !== 'tts') throw new AudioPlanError('unsupported_mode', 'Speech generation requires the tts task type')
    const design = /breeze-tts-2/iu.test(model)
    const tts2 = /^tts2$/iu.test(model)
    const voice = reference ?? text(params, 'voice')
    const instructions = text(params, 'instructions')
    if (input.prompt.trim() === '') throw new AudioPlanError('missing_input', 'Enter the text to speak')
    if (design && voice !== '') throw new AudioPlanError('unsupported_reference', 'Breeze voice cloning is not enabled by this gateway; remove the reference to design a voice')
    if (design && instructions === '') throw new AudioPlanError('missing_input', 'Describe the Breeze voice and delivery in instructions')
    if (!design && !tts2 && voice === '') throw new AudioPlanError('missing_input', 'Speech needs a voice before it can speak')
    if (tts2 && voice !== '' && text(params, 'ref_text') === '') {
      throw new AudioPlanError('missing_input', 'tts2 voice cloning needs ref_text: the exact transcript of the reference audio')
    }
    if (tts2 && text(params, 'language') !== '') {
      throw new AudioPlanError('unsupported_mode', 'tts2 detects the language from the text; remove language')
    }
    const effective = selected(params, ['instructions', 'seed', 'language', 'speed', 'max_new_tokens', 'format', ...(tts2 ? ['ref_text'] : [])])
    const base = { model, prompt: input.prompt, params: { ...effective, ...reference !== undefined || voice === '' ? {} : { voice } }, ...voice === '' ? {} : { reference: { field: 'voice' as const, value: voice } } }
    return transport === 'videos_task'
      ? { ...base, transport, metadata: { ...effective, task_type: 'tts' } }
      : { ...base, transport, ...instructions === '' ? {} : { instructions } }
  }
  const mode = text(params, 'task_type') || 't2m'
  if (!['t2m', 'cover', 'repaint'].includes(mode) || (capability !== undefined && !(capability.taskTypes ?? ['t2m']).includes(mode))) {
    throw new AudioPlanError('unsupported_mode', `Music model ${model} does not offer ${mode}; choose a mode from its capability catalog`)
  }
  let prompt = input.prompt
  const metadata: Record<string, string | number | boolean> = { task_type: mode }
  let audio: AudioPlan['reference']
  if (/minimax-music3/iu.test(model)) {
    if (mode !== 't2m' || reference !== undefined) throw new AudioPlanError('unsupported_mode', 'MiniMax Music3 generates songs from lyrics and style; choose a model offering audio edits for this source')
    const lyrics = text(params, 'lyrics')
    if (lyrics === '' || input.prompt.trim() === '') throw new AudioPlanError('missing_input', 'MiniMax Music3 needs both lyrics and a style description')
    prompt = lyrics
    Object.assign(metadata, selected(params, ['seed', 'max_new_tokens']), { instructions: input.prompt })
  } else if (/ace[-_]?step/iu.test(model)) {
    Object.assign(metadata, selected(params, ['lyrics', 'audio_duration', 'bpm', 'vocal_language', 'key_scale', 'audio_cover_strength', 'repainting_start', 'repainting_end', 'repaint_mode', 'repaint_strength', 'guidance_scale', 'inference_steps', 'seed', 'use_random_seed', 'thinking']), { batch_size: 1 })
    if (metadata.seed !== undefined && metadata.use_random_seed === undefined) metadata.use_random_seed = false
    if ((params.is_instrumental ?? params.instrumental) === true) {
      metadata.instrumental = true
      metadata.lyrics = '[Instrumental]'
    } else if (text(params, 'lyrics') === '' && mode === 't2m') metadata.sample_mode = true
    if (mode !== 't2m') {
      const field = mode === 'cover' ? 'reference_audio' : 'src_audio'
      const source = reference ?? text(params, field)
      if (source === '') throw new AudioPlanError('missing_input', `${mode} needs a source audio version`)
      audio = { field, value: source }
      if (mode === 'repaint' && (typeof params.repainting_start !== 'number' || typeof params.repainting_end !== 'number'
        || params.repainting_start < 0 || params.repainting_end <= params.repainting_start)) {
        throw new AudioPlanError('invalid_range', 'Choose a repaint end after its start, with a nonnegative start')
      }
    }
  } else if (/yue[-_]?2/iu.test(model)) {
    if (mode !== 't2m' || reference !== undefined) throw new AudioPlanError('unsupported_reference', 'YuE2 edits compositions through ABC; use an existing score instead of an audio reference')
    const cot = text(params, 'cot') || 'full'
    if (!['full', 'melody', 'off'].includes(cot)) throw new AudioPlanError('unsupported_mode', 'YuE2 planning must be full, melody, or off')
    Object.assign(metadata, selected(params, ['lyrics', 'abc', 'seed']), { cot })
  } else {
    if (mode !== 't2m' || reference !== undefined) throw new AudioPlanError('unsupported_mode', `Audio edits for ${model} need a model-specific request mapping`)
    Object.assign(metadata, selected(params, ['lyrics', 'is_instrumental']), { instructions: input.prompt })
  }
  const { reference_audio: _reference, src_audio: _source, ...receipt } = metadata
  return { model, prompt, transport: 'videos_task', metadata,
    params: { ...receipt, .../minimax-music3/iu.test(model) ? { lyrics: prompt } : {} },
    ...audio === undefined ? {} : { reference: audio } }
}
