# WeChat

English | [中文](wechat.zh.md)

<a id="summary"></a>

## Summary

The experimental [WeChat integration](../../packages/experimental/wechat/README.md) lets one linked owner use persistent agent sessions from a private chat. The Host handles login, message polling and reply delivery; the [settings card](../../packages/experimental/client-ui-wechat/README.md) exposes connection controls.

<a id="table-of-contents"></a>

## Table of Contents

- [Runtime flow](#runtime-flow)
- [Data and privacy](#data-and-privacy)
- [Further reading](#further-reading)
- [Dev Note](#dev-note)

<a id="runtime-flow"></a>

## Runtime flow

The Host accepts messages only from the linked owner. Each accepted message enters the ordinary Session history and agent turn in the selected project. Replies and generated artifacts return to that chat; delivery failures retain local files and report the failure. The Host must remain running to receive messages.

The `wechat` service owns connection state. Its Remote namespace supplies the settings controls and sanitized status stream. The package README describes commands and session selection; the generated reference below owns the exact service and event signatures.

<a id="data-and-privacy"></a>

## Data and privacy

The Host stores credentials, the polling cursor and recent-session metadata under `$DSH_HOME/wechat`. Stored tokens are absent from the status stream and Session records. Message text and attachment references remain part of ordinary Session history. Logout removes credentials and the cursor while retaining the project binding.

<a id="further-reading"></a>

## Further reading

- [Host package](../../packages/experimental/wechat/README.md)
- [Installable bundle](../../packages/experimental/wechat-bundle/README.md)
- [Session lifecycle](session.md)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

## Dev Note

None.
