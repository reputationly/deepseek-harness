---
description: "项目画布和媒体生成工具的包索引。"
kind: "package-group"
---

# media/ — 画布与媒体生成

[English](README.md) | 中文

## 摘要

通过媒体网关生成图片、视频、语音和音乐，并保存这些结果所在的项目画布。模型在对话中编排画布，并把画布上的节点或组作为输入传给生成工具。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

每个包负责自身配置和模型工具；子系统参考描述它们共享的画布文档。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [canvas](canvas/README.zh.md) | 项目画布文档、`canvas_get` 和 `canvas_edit` 工具，以及 `canvas` Remote 命名空间 | `ctx.canvas` |
| [tool-media](tool-media/README.zh.md) | 基于 OpenAI 兼容媒体网关的 `generate_image`、`generate_video`、`generate_speech` 和 `generate_music` | - |

-----

<a id="related-documentation"></a>
## 相关文档

Web Client 只显示画布并转发用户编辑。

- [画布](../../docs/subsystems/canvas.zh.md) — 文档、操作、生成输入和生成的服务参考。
- [画布标签页](../client/ui-sidebar-canvas/README.zh.md) — 显示画布的右侧栏标签页。
- [对话驱动画布](../../.agents/notes/implemented/feature/2026-11-10-conversation-driven-canvas.zh.md) — 设计决策与备选方案。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
