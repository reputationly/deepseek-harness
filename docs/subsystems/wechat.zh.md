# 微信

[English](wechat.md) | 中文

<a id="summary"></a>

## 摘要

实验性的[微信集成](../../packages/experimental/wechat/README.zh.md)让已绑定的所有者通过私聊使用持久化 Agent 会话。Host 负责登录、消息轮询与回复投递；[设置卡片](../../packages/experimental/client-ui-wechat/README.zh.md)提供连接控制。

<a id="table-of-contents"></a>

## 目录

- [运行流程](#runtime-flow)
- [数据与隐私](#data-and-privacy)
- [延伸阅读](#further-reading)
- [开发备注](#dev-note)

<a id="runtime-flow"></a>

## 运行流程

Host 仅接收已绑定所有者的消息。每条有效消息进入所选项目中的普通 Session 历史与 Agent 轮次。回复和生成的文件返回该私聊；投递失败时保留本地文件并报告失败。Host 必须持续运行才能接收消息。

`wechat` 服务拥有连接状态，其 Remote 命名空间提供设置控制与脱敏状态流。包 README 说明命令和会话选择；下方生成的参考内容负责精确的服务与事件签名。

<a id="data-and-privacy"></a>

## 数据与隐私

Host 将凭据、轮询游标和最近会话元数据保存在 `$DSH_HOME/wechat`。状态流与 Session 记录不包含存储的令牌。消息文本和附件引用仍属于普通 Session 历史。退出登录删除凭据与游标，并保留项目绑定。

<a id="further-reading"></a>

## 延伸阅读

- [Host 包](../../packages/experimental/wechat/README.zh.md)
- [可安装 Bundle](../../packages/experimental/wechat-bundle/README.zh.md)
- [Session 生命周期](session.zh.md)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwechat--wechatservice"></a>

### `ctx.wechat` — `WechatService`

Owns QR login, the durable iLink cursor, and the WeChat-to-Agent bridge.

```ts cordis-catalog
/**
 * Read the sanitized current state for the local settings page.
 * @returns Sanitized current status and workspace snapshot.
 */
@Remote async getStatus(): Promise<WechatSnapshot>

/**
 * Open a new local QR login and begin polling its status.
 * @returns Sanitized current status and workspace snapshot.
 */
@Remote async startLogin(): Promise<WechatSnapshot>

/**
 * Cancel the pending QR login without removing saved credentials.
 * @returns Sanitized current status and workspace snapshot.
 */
@Remote async cancelLogin(): Promise<WechatSnapshot>

/**
 * Reconnect using the saved iLink credentials.
 * @returns Sanitized current status and workspace snapshot.
 */
@Remote async reconnect(): Promise<WechatSnapshot>

/**
 * Stop polling while retaining credentials for a later reconnect.
 * @returns Sanitized current status and workspace snapshot.
 */
@Remote async disconnect(): Promise<WechatSnapshot>

/**
 * Delete the saved iLink token and cursor and stop the local connection.
 * @returns Sanitized current status and workspace snapshot.
 */
@Remote async logout(): Promise<WechatSnapshot>

/**
 * Select an existing registered project as the default WeChat workspace.
 * @param projectPath - Path of an existing registered workspace.
 * @returns Sanitized current status and workspace snapshot.
 */
@Remote async setDefaultProject(projectPath: string): Promise<WechatSnapshot>

/**
 * Stream sanitized status changes to the settings page.
 * @param signal - Cancels this request or subscription.
 * @returns Sanitized status updates until the subscription is cancelled.
 */
@Remote({ mode: 'stream' }) async *watchStatus(signal: AbortSignal): AsyncIterable<WechatStatus>
```

Source: [`packages/experimental/wechat/src/index.ts`](../../packages/experimental/wechat/src/index.ts)

<a id="wechat-events"></a>

### `wechat/*` events

<a id="wechatstatus--emit"></a>

#### `wechat/status` — emit

The local iLink binding changed its public connection state.

```ts cordis-catalog
/**
 * The local iLink binding changed its public connection state.
 * @mode emit
 * @param status - the sanitized WeChat connection state.
 * @param error - an optional localized public error.
 */
'wechat/status'(status: WechatStatus, error?: string): void
```

Source: [`packages/experimental/wechat/src/types.ts`](../../packages/experimental/wechat/src/types.ts)
<!-- END GENERATED cordis-surface -->

<a id="dev-note"></a>

## 开发备注

无。
