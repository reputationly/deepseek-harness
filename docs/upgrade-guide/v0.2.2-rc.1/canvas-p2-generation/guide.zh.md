---
kind: upgrade-guide
description: "画布 P2 加入生成工具与制作阶段记录，场次组按来源剧本记录去重，不再依赖组标题。"
---

# 画布可以生成了，场次组会记录它来自哪里

[English](guide.md) | 中文

## 变更

媒体工具现在可以按节点生成，不必由 Agent 手动逐个调用：

- `canvas_generate` 对给定节点做一次规划，报出视频调用次数、视频秒数、图片张数、配音句数、音乐次数，用户同意后才开始。一张分镜表按切段结果生成每段一个视频节点。开始后立即返回任务 id，完成情况以任务通知到达；上一任务仍在排队或运行的节点会以 `already_running` 拒绝。
- `storyboard_voice` 为每句台词建一个音频节点，分镜改写后仍按台词 id 复用。
- `studio_stage` 记录并推进当前这一集的制作阶段。

两处面向部署的细节变化：

- `tool-media` 新增 `videoRefModel`、`maxSegmentSeconds`、`generateConcurrency` 以及决定何时需要用户确认的 `confirm*` 阈值。
- `studio_expand_script` 改为按场次组记录的来源去重（`sceneOrigin: { script, scene }`），不再看标题。用户改过组名不会再生成第二份场次，恰好叫「场1」的无关分组也不会再被误当作已铺开。

`studio_bible_update` 现在按 id 替换同名条目（与它的说明一致），不再追加一个同 id 的重复条目。

## 迁移

1. 只有需要新的来源记录时才重跑 `studio_expand_script`；旧画布仍可读，缺失的字段按「不是从剧本铺开的」处理。
2. 如果某个项目依赖旧的标题去重，先手动清理重复的场次组，再重新铺开剧本。
3. 自建模型的部署应按网关能力设置 `videoRefModel` 与 `maxSegmentSeconds`。
