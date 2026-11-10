---
description: "在 Web 右侧栏查看和整理项目画布。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-canvas

[English](README.md) | 中文

## 概述

在右侧栏添加一个画布 tab，显示助手在对话过程中搭建的项目画布：图片、视频、音频和文本卡片，组框，以及它们之间的边。tab 会跟随助手的编辑实时更新，用户也可以移动、连接、分组和删除节点。

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
- id: ui-sidebar-canvas
  name: '@deepseek-ai/dsh-client-ui-sidebar-canvas'
```

Web bundle 里这一行默认禁用；与 Host 的 `canvas` 行一起启用。打开右侧栏，在开始页选择**画布**。

拖动卡片可以移动它，拖动组框可以连同成员一起移动整个组。从一张卡片右边缘的 handle 拖到另一张卡片左边缘的 handle 即可连线。按住 Ctrl 或 Cmd 选中多张卡片，再点工具栏里的**编组**。按 Delete 或点**删除**可以移除选中的卡片和边；删除组框只解散组，成员保留。工具栏还提供缩放、适应视图和刷新。

图片在卡片出现时加载。视频和音频在用户点击播放时加载。Host 没有完全应用的编辑（例如会成环的连线）会显示在画布上方的提示里，画布本身保持可见。

<a id="understand-the-implementation"></a>
## 理解实现

`CanvasSource` 保存一个 Session 的画布状态。它通过 `canvas.get` 读取，通过 `canvas.apply` 发送编辑，在每次编辑之后以及收到所显示项目的 `canvas/change` 事件之后重新读取，并且只让最新一次读取生效。刷新失败时屏幕上保留上一份文档。

文档归 Host 所有。手势被转换成操作列表（`move`、`connect`、`group`、`ungroup`、`remove`、`disconnect`），画面按 Host 返回的文档重绘；位置和 id 从不在浏览器里决定。`flow.ts` 是两个方向上的纯映射。

flow 库 `@xyflow/react` 和节点卡片放在单独的 chunk 里，第一次显示有节点的画布时才加载。媒体字节用 `workspaceFiles.readBytes` 读取，通过 object URL 显示，卡片卸载时回收。

<a id="model-experience"></a>
## 模型体验

无；此包只显示画布并把用户的编辑发给 Host，不向模型请求添加内容。

#### KV 缓存影响

无；画布文档和媒体字节只在浏览器与 Host 之间传输。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 没有撤销，不能就地编辑标题或文本，也不能调整卡片大小。
- 超过 Host 整文件读取上限的媒体文件会在卡片上显示加载失败。
- tab 宽度小于 720px 时隐藏缩略图。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护说明</summary>

无。

</details>
