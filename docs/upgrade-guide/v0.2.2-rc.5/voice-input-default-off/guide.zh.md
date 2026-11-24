---
kind: upgrade-guide
description: "Dictation（语音输入）不再默认启用：桌面 profile 与旧版 web profile 中残留的 voice-input 组合会被还原为当前组合，插件仍可手动开启。"
---

# Dictation 不再默认启用

[English](guide.md) | 中文

## 变更

早前的版本把 `@deepseek-ai/dsh-experimental-voice-input-bundle`（语音输入：本地 SenseVoice 语音识别、它的 HTTP 提供方，以及输入框上的麦克风）加入了 Web 组合，于是新建 profile 会列出它，首次启动就能看到麦克风。本地语音模型并不随发布包分发，因此该功能按发布形态无法使用。

现在随包发布的 Web 模板只组合 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`。两处迁移让既有安装保持一致：

- 名为 `web` 的 profile，若其 bundle 列表恰好等于早前版本写入的某个列表（含插件市场、语音输入与微信组合），由 profile 加载器通过 `INSTALLATION_OWNED_PROFILE_TUPLES` 还原为当前模板。
- 桌面 profile 不以随包模板命名，因此 Desktop 壳在 Host 启动前自行执行同样的还原：只有与早前列表完全一致时才改写，其他列表（包括用户自己改过的）一律保持不变。

该组合仍会安装并由插件市场提供，想用语音输入的人仍可在提供语音模型后开启它。

## 迁移

1. 接受新的默认值时无需修改。确认：输入框上没有麦克风，且 `$DSH_HOME/profiles/<profile>/package.json` 不再列出 `@deepseek-ai/dsh-experimental-voice-input-bundle`。
2. 若要保留语音输入，在此版本之后到插件市场开启 **语音输入**；profile 会重新列出该组合，而它的列表已不再是早前的默认列表，因此 Desktop 不会再改写它。
