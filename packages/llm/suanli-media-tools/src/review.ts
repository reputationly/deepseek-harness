/** Requirement review: the selected vision model judges whether generated files match what the user asked for. */
import type { Context } from '@deepseek-ai/cordis'

/** The vision model's judgement of one generation. */
export interface Review {
  readonly verdict: 'match' | 'partial' | 'mismatch'
  readonly reason: string
}

/**
 * Ask the vision model whether the files match the request, when the user keeps review on.
 * Safety review stays with the gateway; this judges content against the request only. Any failure skips the review.
 * @param ctx - plugin context.
 * @param prompt - what the user asked for.
 * @param files - generated artifact URLs and their media types.
 * @returns the judgement, or undefined when review is off, has no vision model, or failed.
 * URLs avoid uploading a second copy of a 4K image or video.
 */
export async function review(
  ctx: Context, prompt: string, files: readonly { readonly url: string; readonly mediaType: string }[],
): Promise<Review | undefined> {
  if (!ctx.suanliModels.preferences().autoReview) return undefined
  const vision = ctx.suanliModels.roles().find(state => state.role === 'vision')
  const model = vision?.selected ?? vision?.fallback ?? null
  if (model === null || files.length === 0) return undefined
  const kind = files[0]?.mediaType.startsWith('video/') === true ? 'video' : 'image'
  const answer = await ctx.suanliMedia.inspect({
    model,
    instruction: [
      `用户的生成要求是：「${prompt}」。`,
      `判断附带的${kind === 'video' ? '视频' : '图片'}内容是否符合这个要求，只看是否符合，不做安全审核。`,
      '只输出一行 JSON：{"verdict":"match|partial|mismatch","reason":"不超过 40 字的中文理由"}',
    ].join('\n'),
    media: files.map(file => ({ kind, url: file.url })),
  }).catch(() => undefined)
  return answer?.ok === true ? parse(answer.text) : undefined
}

/**
 * @param text - the vision model's answer.
 * @returns the judgement it states, or undefined when it states none.
 */
function parse(text: string): Review | undefined {
  const json = /\{[\s\S]*\}/u.exec(text)?.[0]
  if (json === undefined) return undefined
  try {
    const value = JSON.parse(json) as { verdict?: unknown; reason?: unknown }
    const { verdict, reason } = value
    if (verdict !== 'match' && verdict !== 'partial' && verdict !== 'mismatch') return undefined
    return { verdict, reason: typeof reason === 'string' ? reason.slice(0, 200) : '' }
  } catch {
    return undefined
  }
}
