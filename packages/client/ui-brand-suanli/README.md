---
description: "This product's sidebar brand mark and wordmark, plus the blank-home mark, over the shared sidebar and conversation hero slots."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-suanli

English | [中文](README.zh.md)

## Summary

Supplies the product identity the sidebar and the blank home render: the mark, the wordmark with the gateway connection light after it, and the hero mark. The package occupies the same three slots the upstream brand package fills, so a deployment chooses one of the two by composing one row in `packages/bundle/web-app/cordis.patch.yml`.

The wordmark reads `DSH_CLIENT_TITLE` at build time, so the product name stays a build input rather than source text. The connection light beside it polls the Host `gatewayStatus` namespace: every 30 s while connected, every 3 s while disconnected, and never while the sidebar shows the collapsed rail.

## Occupied slots

| Slot | Component |
|---|---|
| `sidebar.brand.mark` | the product mark at the size the sidebar requests |
| `sidebar.brand.name` | the wordmark, followed by the gateway connection light |
| `conversation.hero.brand.mark` | the mark on the blank home |

The blank home's `conversation.hero.frame` layer stays free, so no decoration is drawn behind the mark.

## Model Experience

This package contributes browser presentation only: no tool, prompt, token, or cache effect. Its host half is an inert `apply`, so the Loader row exists with no host-side behavior.
