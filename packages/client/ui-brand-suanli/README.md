---
description: "This product's sidebar brand mark and wordmark, plus the blank-home mark, over the shared sidebar and conversation hero slots."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-suanli

English | [中文](README.zh.md)

## Summary

Supplies the product identity the sidebar and the blank home render: the mark, the wordmark with the gateway connection light after it, and the hero mark. The package occupies the same three slots the upstream brand package fills, so a deployment chooses one of the two by composing one row in `packages/bundle/web-app/cordis.patch.yml`.

The wordmark reads `DSH_CLIENT_TITLE` at build time, so the product name stays a build input rather than source text. The connection light beside it polls the Host `gatewayStatus` namespace: every 30 s while connected, every 3 s while disconnected, and never while the sidebar shows the collapsed rail.

## Table of Contents

- [Occupied slots](#occupied-slots)
- [Model Experience](#model-experience)

## Occupied slots

| Slot | Component |
|---|---|
| `sidebar.brand.mark` | the product mark at the size the sidebar requests |
| `sidebar.brand.name` | the wordmark, followed by the gateway connection light |
| `conversation.hero.brand.mark` | the mark on the blank home |
| `settings.models.footer` | the catalog-refresh row: syncs the picker's models from this deployment's gateway |
| `tool.call.toolview` (`generate_image`, `generate_video`, `generate_music`, `generate_speech`) | the chat generation cards: images through the attachment gallery, with 「Open in Creative」 handing them to the `suanliCreative` Client service when the creative workbench is loaded (otherwise the card says it is not enabled); videos and music read from the Session workspace window by window when the user presses play, then shown in the native player |

The blank home's `conversation.hero.frame` layer stays free, so no decoration is drawn behind the mark.

## Model Experience

None, as this package renders browser presentation only and contributes no prompt, tool schema, or tool result.

#### KV Cache effect

None: nothing this package renders is part of a model request.

## Known Limitations and Deferred Work

- The wordmark uses the Ma Shan Zheng subset ui-theme ships, which covers the current five-character product name only; renaming needs a new subset, or missing glyphs fall back to the system font.

### Dev Note

`ui-sidebar` declares `sidebar.brand.mark` and `sidebar.brand.name`, and ui-conversation declares `conversation.hero.brand.mark`; this package fills all three, and the wordmark row stretches so the connection light lands on the same right edge as the New Session button.
