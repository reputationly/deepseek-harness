---
description: "Connect a private WeChat chat to a local DSH agent through Tencent iLink."
kind: "package-reference"
---

# @deepseek-ai/dsh-wechat

English | [中文](README.zh.md)

<a id="summary"></a>

## Summary

Connect one private WeChat chat to an Agent that keeps conversation history in the chosen project. Scan a QR code to log in and receive replies and generated files in that chat. The Host must stay running; other accounts and group messages are ignored.

<a id="table-of-contents"></a>

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

Enable the [WeChat ClawBot bundle](../wechat-bundle/README.md) to install the Host service and its settings card. Scan the QR code from Settings → WeChat with the owner account. Messages from other accounts and group chats are ignored.

The service stores credentials, the iLink cursor, and recent-session metadata under `$DSH_HOME/wechat`; POSIX files use mode `0600`. Logout removes credentials and the cursor. The default project is `$DSH_HOME/wechat/project`, and downloaded attachments are saved under that workspace's `wechat-inbox/` directory.

Each direct message becomes a user message in a persistent workspace-write session under the configured default model and, when available, the default Agent preset. Created and resumed sessions are attached to their project workspace. `/new`, `/list`, `/use <n>`, `/项目 [名称|序号]` (`/project`), `/cancel`, and `/help` manage conversations and projects. The `wechat_send_file` tool is registered only in WeChat-origin sessions; generated media in a turn is sent automatically when the turn ends.

The local status contracts `WechatStatus` and `WechatSnapshot` are defined in [src/types.ts](src/types.ts). `watchStatus` streams sanitized connection updates to the settings card; login credentials remain in Host-owned storage.

<a id="model-experience"></a>

## Model Experience

### WeChat-origin Session turns

#### What the model sees

Inbound text and available voice transcripts become user messages in the normal Session log. Downloaded attachments are saved in the selected workspace and their relative paths are included in that message. The WeChat-only `wechat_send_file` tool adds its schema to those sessions.

#### Token effect

Each handled message uses the selected model's ordinary Session turn and tool-schema tokens. This package makes no independent model request.

#### KV Cache effect

Messages, attachment paths, and tool results append to Session history. Activating the WeChat-only tool can change the schema prefix; otherwise cache reuse follows the selected provider and retained history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only private messages from the linked owner are supported. Group messages and other senders are ignored.
- The Host must remain running and the computer awake to receive messages.
- This integration is experimental and depends on Tencent iLink availability and protocol behavior.

<a id="dev-note"></a>

### Dev Note

Protocol requests live in [src/protocol.ts](src/protocol.ts); durable local records live in [src/storage.ts](src/storage.ts). The constructor's second argument is the empty deployment configuration; runtime dependency overrides belong in its third argument for integration tests.
