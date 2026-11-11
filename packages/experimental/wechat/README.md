---
description: "Connect a private WeChat chat to a local DSH agent through Tencent iLink."
kind: "package-reference"
---

# @deepseek-ai/dsh-wechat

English | [中文](README.zh.md)

## Summary

This Host service binds one WeChat owner account to persistent DSH sessions through Tencent iLink. It owns QR login, message polling, local credential storage, project selection, and delivery of agent replies.

## Use this package

Enable the [WeChat ClawBot bundle](../wechat-bundle/README.md) to install the Host service and its settings card. Scan the QR code from Settings → WeChat with the owner account. Messages from other accounts and group chats are ignored.

The service stores credentials, the iLink cursor, and recent-session metadata under `$DSH_HOME/wechat`; credentials are written with mode `0600`. Logout removes credentials and the cursor. The default project is `$DSH_HOME/wechat/project`, and downloaded attachments are saved under that workspace's `wechat-inbox/` directory.

Each direct message becomes a user message in a persistent workspace-write session under the configured default model and, when available, the default Agent preset. Created and resumed sessions are attached to their project workspace. `/new`, `/list`, `/use <n>`, `/项目 [名称|序号]` (`/project`), `/cancel`, and `/help` manage conversations and projects. The `wechat_send_file` tool is registered only in WeChat-origin sessions; generated media in a turn is sent automatically when the turn ends.

## Model Experience

### WeChat-origin Session turns

#### What the model sees

Inbound text and available voice transcripts become user messages in the normal Session log. Downloaded attachments are saved in the selected workspace and their relative paths are included in that message. The WeChat-only `wechat_send_file` tool adds its schema to those sessions.

#### Token effect

Each handled message uses the selected model's ordinary Session turn and tool-schema tokens. This package makes no independent model request.

#### KV Cache effect

Messages, attachment paths, and tool results use normal Session history and its ordinary cache behavior. This package does not replace earlier request tokens or add a separate prompt.

## Known Limitations and Deferred Work

- Only private messages from the linked owner are supported. Group messages and other senders are ignored.
- The Host must remain running and the computer awake to receive messages.
- This integration is experimental and depends on Tencent iLink availability and protocol behavior.
