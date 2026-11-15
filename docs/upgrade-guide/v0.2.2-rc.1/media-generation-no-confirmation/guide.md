---
kind: upgrade-guide
description: "Canvas media generation no longer asks for budget confirmation; the confirm* config keys are removed and rejected as unknown."
---

# Media generation drops budget confirmation

English | [中文](guide.zh.md)

## Change

`canvas_generate` and `storyboard_voice` start generation directly. They no longer return a quote and token for the user to approve, and the tools take no `confirmToken` argument. The `tool-media` config keys `confirmVideoCalls`, `confirmVideoSeconds`, `confirmImageCalls`, `confirmSpeechLines`, and `confirmMusicCalls` are removed; `tool-media` rejects unknown config keys, so a configuration that still sets them fails to load with `tool-media: unknown config key`. Deployments that never set them are unaffected.

## Migration

1. Delete the five `confirm*` keys from the `tool-media` plugin config in `cordis.yml` or its patch/overlay. If the deployment needs a spend ceiling, enforce it outside `tool-media`.
2. Remove any `confirmToken` argument a prompt or automation passes to `canvas_generate` or `storyboard_voice`; the parameter no longer exists.
3. Confirm the deployment loads: start `dsh` and check the log for no `unknown config key` error, then run one `canvas_generate` and confirm it returns `started` rather than a confirmation request.
