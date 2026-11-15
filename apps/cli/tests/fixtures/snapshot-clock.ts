/** Freeze wall-clock metadata in authored CLI cases without changing timers or the shipped application. */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'snapshot-clock-fixture'

/**
 * Keep creation dates inside model-visible version summaries deterministic.
 * @param ctx - CLI profile lifecycle that owns and restores this process clock.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const original = globalThis.Date
    const instant = original.UTC(2026, 10, 14)
    globalThis.Date = new Proxy(original, {
      construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [instant] : args, newTarget) as Date,
      get: (target, key, receiver): unknown => key === 'now' ? () => instant : Reflect.get(target, key, receiver),
    })
    return () => { globalThis.Date = original }
  })
}
