---
description: "Manage the WeChat ClawBot connection and default project from Settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-wechat

## Summary

This Client package adds a localized WeChat card to Settings. It displays QR login and connection state, exposes reconnect, disconnect, and logout actions, and lets the user choose the default workspace.

## Use this package

Install the [WeChat ClawBot bundle](../wechat-bundle/README.md), which composes this card with the Host service. The card is available under Settings → WeChat. Login credentials and message handling remain owned by the Host service.

## Model Experience

### WeChat settings

#### What the model sees

None. The settings card does not provide model context or tools.

#### Token effect

Zero. This package does not create model requests.

#### KV Cache effect

The card does not read or change Session history or cached request prefixes.

## Known Limitations and Deferred Work

- The card requires the matching WeChat Host service and is not a standalone login client.
- Login and message delivery depend on Tencent iLink and the Host remaining available.
