---
kind: upgrade-guide
description: "Canvas 媒体生成不再询问预算确认；confirm* 配置键已移除并作为未知键被拒绝。"
---

# 媒体生成取消预算确认

[English](guide.md) | 中文

## 变更

`canvas_generate` 与 `storyboard_voice` 直接开始生成，不再返回需用户批准的报价与令牌，工具也不再接受 `confirmToken` 参数。`tool-media` 的配置键 `confirmVideoCalls`、`confirmVideoSeconds`、`confirmImageCalls`、`confirmSpeechLines`、`confirmMusicCalls` 已移除；`tool-media` 会拒绝未知配置键，因此仍设置这些键的配置会以 `tool-media: unknown config key` 加载失败。未设置这些键的部署不受影响。

## 迁移

1. 从 `cordis.yml` 或其 patch/overlay 中 `tool-media` 插件配置里删除五个 `confirm*` 键。部署若需要支出上限，请在 `tool-media` 之外实施。
2. 移除提示词或自动化传给 `canvas_generate`、`storyboard_voice` 的任何 `confirmToken` 参数；该参数已不存在。
3. 确认部署可加载：启动 `dsh` 并检查日志没有 `unknown config key` 错误，然后运行一次 `canvas_generate`，确认它返回 `started` 而非确认请求。
