import type { SessionId } from '@deepseek-ai/dsh-session'

/** Public connection state; credentials and protocol tokens never leave Host. */
export type WechatStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'qr-pending'; readonly qrDataUrl: string; readonly expiresAt: number }
  | { readonly state: 'scanned' }
  | { readonly state: 'connecting' }
  | { readonly state: 'connected'; readonly botId: string }
  | { readonly state: 'reconnecting'; readonly lastError: string }
  | { readonly state: 'logged-out' }

/** One workspace available to the WeChat session. */
export interface WechatProject {
  readonly id: string
  readonly title: string
  readonly path: string
}

/** Sanitized settings snapshot. */
export interface WechatSnapshot {
  readonly status: WechatStatus
  readonly hasCredentials: boolean
  readonly defaultProjectPath?: string
  readonly projects: readonly WechatProject[]
  readonly error?: string
}

/** Recent WeChat session recorded in the local binding state. */
export interface WechatRecentSession {
  readonly sessionId: SessionId
  readonly title: string
  readonly projectPath: string
  readonly updatedAt: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    wechat: import('./index.ts').WechatService
  }

  interface Events {
    /**
     * The local iLink binding changed its public connection state.
     * @mode emit
     * @param status - the sanitized WeChat connection state.
     * @param error - an optional localized public error.
     */
    'wechat/status'(status: WechatStatus, error?: string): void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** User message received over the local WeChat iLink binding. */
    wechat: { readonly kind: 'wechat' }
  }
}

export {}
