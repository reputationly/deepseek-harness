/** `generate_speech`: read text aloud with the catalog's speech model and save the audio in the Session workspace. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-suanli-model-catalog'
import { publishArtifact, resolveParameters, workspaceOf } from './common.ts'
import { outputOf, typeOf, type MediaValue } from './media.ts'
import { VOICE } from './params.ts'

/** Longest wait for one synthesis. */
const SPEECH_WAIT_MS = 5 * 60_000

const description = 'Read text aloud and save it as speech audio in the workspace. Pass the exact text to read and '
  + 'the voice the user named in their own words, if any; a missing or unsupported voice is asked of the user. '
  + 'The result is an audio file the user plays in the conversation.'

/** Arguments of `generate_speech`. */
interface SpeechArgs {
  readonly text: string
  readonly voice?: string | undefined
}

/**
 * @param ctx - plugin context.
 * @returns the `generate_speech` tool.
 */
export function speechTool(ctx: Context) {
  return defineTool({
    name: 'generate_speech',
    description,
    parameters: {
      text: { type: 'string', required: true, description: 'The exact text to read aloud.' },
      voice: { type: 'string', description: 'Voice the user named, in their own words. Omit otherwise.' },
    },
    output: outputOf(),
    timeoutMs: SPEECH_WAIT_MS + 600_000,
    async execute(args, exec) {
      return await speak(ctx, args, exec)
    },
  })
}

/**
 * Settle the voice, synthesize, and save the audio.
 * @param ctx - plugin context.
 * @param args - model arguments.
 * @param exec - the execution.
 * @returns the canonical result.
 * @throws When no speech model is offered or the gateway produced nothing.
 */
async function speak(ctx: Context, args: SpeechArgs, exec: ToolExecution): Promise<MediaValue> {
  const state = ctx.suanliModels.roles().find(item => item.role === 'speech')
  const model = state?.selected ?? state?.fallback ?? null
  const entry = model === null
    ? undefined
    : ctx.suanliModels.media().entries.find(item => item.operation === 'generate_speech' && item.model === model)
  if (state === undefined || model === null || entry === undefined) throw new Error('No speech model is available in the gateway catalog.')
  const modelLabel = state.candidates.find(candidate => candidate.model === model)?.label ?? model
  const base = { prompt: args.text, model, modelLabel }
  const cwd = await workspaceOf(ctx, exec)
  const parameters = await resolveParameters(ctx, entry, [[VOICE, args.voice]], exec)
  if (parameters === undefined) return { ...base, status: 'cancelled', parameters: [], media: [] }
  exec.signal.throwIfAborted()
  const { path, data } = await publishArtifact(ctx, 'Speech', cwd,
    async (target) => {
      const spoken = await ctx.suanliMedia.speak({ model, input: args.text, params: parameters }, target)
      exec.signal.throwIfAborted()
      return spoken
    },
    bytes => typeOf(bytes, 'music').extension)
  return {
    ...base,
    status: 'generated',
    parameters: Object.entries(parameters).map(([key, value]) => ({ key, value })),
    media: [{ path, mediaType: typeOf(data, 'music').mediaType }],
  }
}
