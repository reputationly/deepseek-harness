---
kind: upgrade-guide
description: "Dictation（语音输入）不再默认启用：桌面 profile 与旧版 web profile 中残留的 voice-input 组合会被移除，插件仍可手动开启。"
---

# Dictation is no longer enabled by default

English | [中文](guide.zh.md)

## Change

An earlier release added `@deepseek-ai/dsh-experimental-voice-input-bundle` (dictation: local SenseVoice speech-to-text, its HTTP provider, and the composer microphone) to the Web composition, so new profiles listed it and the microphone appeared on the first launch. The local speech model is not part of the release, so the feature cannot work as shipped.

The shipped Web template now composes `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` only. Two migrations keep existing installations consistent:

- Profiles named `web` whose bundle list is exactly one an earlier release wrote (with the market, dictation, and WeChat bundles) are normalized to the current template by the profile loader, through `INSTALLATION_OWNED_PROFILE_TUPLES`.
- The Desktop profile is not named after a shipped template, so the Desktop shell applies the same normalization itself before the Host starts: an exact earlier list becomes the current template, and every other list — including one a person changed — is left alone.

The bundle stays installed and offered by the plugin manager, so anyone who wants dictation can still enable it after providing a speech model.

## Migration

1. To accept the new default, change nothing. Confirm: the composer has no microphone, and `$DSH_HOME/profiles/<profile>/package.json` no longer lists `@deepseek-ai/dsh-experimental-voice-input-bundle`.
2. To keep dictation, enable **Voice input** in the plugin manager after this release; the profile then lists the bundle again, and the Desktop leaves that choice alone because the removal only applies to a profile it finds still carrying the earlier default.
