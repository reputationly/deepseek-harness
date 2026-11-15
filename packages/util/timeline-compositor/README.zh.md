---
description: "浏览器安全的时间线求值、画面合成、字幕与音频混合。"
kind: "package-library"
---

# dsh-util-timeline-compositor

[English](README.md) | 中文

<a id="summary"></a>

## 概述

编辑器的完整质量缓存和导出编码器共用这套无状态合成函数。库接收已校验的时间线和调用方拥有的解码媒体，不打开文件、不调用 Remote，也不注册 Cordis 服务。画布只通过类型依赖提供时间线结构。

## 目录

- [合成](#composition)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="composition"></a>
## 合成

`timelineFramesAt` 求出某一时刻可见的片段。`paintTimeline` 把这些画面、图片运镜、变换、转场和字幕绘制到传入的绘图上下文。`timelineGain` 与 `mixTimelineAudio` 在同一时间坐标中应用轨道和片段的音量与淡入淡出。可见素材缺帧时抛出 `TimelineFrameError`，阻止发布不完整画面。

编解码适配器负责解码、字体加载、编码和资源释放。缓存预览和导出播放同一个最终 MP4；这个库不另设预览渲染器。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 合成使用调用方提供的绘图上下文和字体，不安装字体或选择编解码器。
- 这个库不保证实时播放。编辑器等完整质量缓存完成后再播放。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

保持此模块不依赖 Host 服务或文件系统，使客户端打包器能够内联它。

</details>
