---
description: "Manage the WeChat ClawBot connection and default project from Settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-wechat

English | [中文](README.zh.md)

<a id="summary"></a>

## Summary

This Client package adds a localized WeChat card to Settings. It displays QR login and connection state, exposes reconnect, disconnect, and logout actions, and lets the user choose the default workspace. In Desktop, the card also includes the shared keep-awake preference when the versioned power bridge is available.

<a id="table-of-contents"></a>

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Install the [WeChat ClawBot bundle](../wechat-bundle/README.md), which composes this card with the Host service. The card is available under Settings → WeChat. Login credentials and message handling remain owned by the Host service.

<a id="model-experience"></a>

## Model Experience

### WeChat settings

#### What the model sees

None. The `wechat` settings card does not provide model context or tools. [Component tests](tests/components.client.spec.tsx) cover its settings actions.

#### Token effect

Zero. This package does not create model requests.

#### KV Cache effect

The card does not read or change Session history or cached request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The card requires the matching WeChat Host service and is not a standalone login client.
- Login and message delivery depend on Tencent iLink and the Host remaining available.

<a id="dev-note"></a>
### Dev Note

The [mount tests](tests/mount.client.spec.ts) own contribution registration and cleanup.
