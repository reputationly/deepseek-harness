import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

/** Services needed to mount the WeChat Client contribution. */
export const inject = ['remote', 'slots', 'locale']

/** Mount the generated Host Remote before rendering its settings page. */
export async function mountWechat(
  ctx: Context,
  contribution: TypertRemoteContribution,
  registerUi: (scope: Context) => void | Promise<void>,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const disposeUi = ctx.inject(['remote.wechat', 'slots', 'locale'], registerUi)
  try {
    await disposeUi
  } catch (error) {
    await disposeUi.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await disposeUi.dispose()
    await disposeRemote()
  }
}
