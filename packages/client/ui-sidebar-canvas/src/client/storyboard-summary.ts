import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { StoryboardSummary } from './model/table.ts'

const pluralKey = (count: number): 'one' | 'other' => count === 1 ? 'one' : 'other'

/** Localized unit counts for a storyboard card or table footer. */
export function formatStoryboardSummary(summary: StoryboardSummary, t: PropsLocale<typeof NS>['t']): string {
  const count = (unit: 'shots' | 'seconds' | 'segments' | 'calls', value: number) =>
    t(`storyboard.${unit}.${pluralKey(value)}`, { count: value })
  return t('storyboard.summary', {
    shots: count('shots', summary.shots),
    seconds: count('seconds', summary.seconds),
    segments: count('segments', summary.segments.length),
    calls: count('calls', summary.videoCalls),
  })
}
