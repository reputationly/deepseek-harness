import { IconNewChatOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Render the WeChat settings entry's conversation icon. */
export function WechatSettingsIcon({ size }: PropsRuntime<'settings.section.icon'>) {
  return <IconNewChatOutlineMedium size={size} />
}
