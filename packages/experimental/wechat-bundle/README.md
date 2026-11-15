---
description: "Bind a private WeChat chat to a local DSH agent through Tencent iLink."
kind: "package-bundle"
---

# @deepseek-ai/dsh-wechat-bundle

English | [中文](README.zh.md)

<a id="summary"></a>

## Summary

The experimental WeChat ClawBot bundle connects a private WeChat chat to a local DSH agent through Tencent iLink. Bind the account from **Settings → WeChat**, then message the ClawBot directly. The selected DSH workspace and conversation are persisted locally and remain available in the desktop application.

The bundle composes the Host integration and its Client settings card. It does not include group-chat support.

<a id="table-of-contents"></a>

## Table of Contents

- [Use this bundle](#use-this-bundle)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-bundle"></a>
## Use this bundle

Install or enable **WeChat ClawBot** from the plugin manager. Open **Settings → WeChat**, select **Add WeChat**, and scan the displayed QR code with the account that owns the private chat.

Keep the desktop application open and prevent the computer from sleeping while using WeChat. Use `/help` in the chat to see the available commands.

<a id="model-experience"></a>

## Model Experience

### Bundle composition

#### What the model sees

The bundle adds no prompt or tool schema itself. [`cordis.patch.yml`](cordis.patch.yml) selects the [Host integration](../wechat/README.md) and the [settings card](../client-ui-wechat/README.md); the Host owns WeChat messages and tools.

#### Token effect

Zero additional prompt/schema tokens from the bundle; the selected Host contribution owns message and tool costs.

#### KV Cache effect

Composition does not rewrite Session history or cached request prefixes; subsequent messages follow the Host integration.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Experimental integration; availability and protocol behavior depend on Tencent iLink.
- Only direct messages from the linked owner account are processed. Group messages are ignored.
- The local host must remain running to receive messages.

<a id="dev-note"></a>
### Dev Note

The [Loader composition test](tests/loader-composition.host.spec.ts) checks the bundle through the shipped profile.
