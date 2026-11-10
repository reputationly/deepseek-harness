---
description: "项目画布文档、canvas_get 与 canvas_edit 模型工具，以及 canvas Remote 命名空间。"
kind: "package-reference"
---

# @deepseek-ai/dsh-canvas

[English](README.md) | 中文

## 概述

为每个项目目录维护一份画布文档，供模型、媒体工具和 Web Client 共同使用。模型用 `canvas_edit` 放置、连接和分组节点，用 `canvas_get` 读取；`generate_image` 和 `generate_video` 接受节点或整个组作为入参，并把结果作为带派生边的节点放回画布。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

```yaml
- id: canvas
  name: '@deepseek-ai/dsh-canvas'
```

base bundle 里这一行默认禁用；部署时与 `tool-media` 和 Client 的 `ui-sidebar-canvas` 行一起启用。插件没有配置项。

文档是 `<project>/.canvas/canvas.json`，其中 `<project>` 是 Session 的原始目录。在同一项目上打开的 Session 共用它。文件不存在就是一张空画布。

其他 Host 插件使用 `ctx.canvas`：`read(session)` 返回文档，`edit(session, operations)` 在一次写入里应用一组操作，`resolveImages(session, ids)` 把图片节点和组解析成图片文件路径。组代表它的图片成员，按阅读顺序排列：从上到下，再从左到右。

<a id="understand-the-implementation"></a>
## 理解实现

`CanvasService` 拥有文档。写入按文件串行执行，先校验，再通过临时文件加 rename 替换原文件。解析或校验失败的文件绝不会被覆盖：读取和编辑以 `CanvasCorruptError` 失败，Remote 命名空间报告带文件路径的 `canvas/corrupt`。

`applyOperations` 按顺序应用 `add`、`update`、`remove`、`connect`、`disconnect`、`group`、`ungroup`、`move` 和 `resize`。`ref` 指代同一组操作里先前创建的节点。指向未知节点、重复连边、会成环或媒体文件不存在的操作会带着原因被跳过，其余操作照常生效。

新节点由 Host 布局：列按边的深度从左到右排，新节点向下挪到不与任何节点重叠，组框按成员重算。用户移动过的节点被标记为 `placed`，不再参与布局。

`canvas` Remote 命名空间向 Client 暴露 `get` 和 `apply`，每次写入都会发出带项目目录的 `canvas/change` 事件。[设计笔记](../../../.agents/notes/implemented/feature/2026-11-10-conversation-driven-canvas.zh.md)记录了各项决策。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`canvas_get` 和 `canvas_edit` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-canvas)。`canvas_get` 接受一个可选的 `nodes` 数组，内容是节点或组的 id。`canvas_edit` 接受一个 `operations` 数组；每个操作写明 `op`（`add`、`update`、`remove`、`connect`、`disconnect`、`group` 或 `ungroup`）以及该操作用到的字段。两个 schema 都没有坐标或尺寸字段。

#### Token 影响

工具可见时，每次请求都有固定的 schema 开销；描述和 schema 不随画布内容变化。

#### KV Cache 影响

定义及其可见性不变时，前缀保持稳定。

### 工具调用历史与结果

#### 模型看到什么

`canvas_get` 为每个节点、每个组（带成员 id）和每条边各返回一行。超过 160 个字符的文本和 prompt 会被截短，除非用 `nodes` 指定要完整读取的 id。`canvas_edit` 返回它创建的 id 及对应的 `ref` 名，并为每个无法应用的操作返回一行 `Skipped operation <index> (<op>): <reason>.`。文档损坏时，两个工具都会失败并给出文件被拒绝的原因。

#### Token 影响

`canvas_get` 的结果随节点和边的数量增长，也随完整读取的节点的文本长度增长。一次 `canvas_edit` 调用的开销是它的操作列表，结果随创建的节点数和被跳过的操作数增长。

#### KV Cache 影响

只追加；调用和结果排在可复用的请求前缀之后，不会使已有的 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 在 Client 里做的编辑不是 Session 事件；模型要到下一次 `canvas_get` 才看到。
- 组不能嵌套，一个节点最多属于一个组。
- 文档还没有备份和迁移路径；`version` 为 `1`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明</summary>

无。

</details>
