---
description: "基于一个 OpenAI 兼容媒体网关的模型可见图片、语音、音乐和视频生成工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-media

[English](README.md) | 中文

## 概述

注册四个通过部署网关生成媒体的工具：`generate_image`（文生图和图片编辑）、`generate_speech`、`generate_music` 和 `generate_video`。每次调用都按引用从凭据存储解析 API key，把生成的文件写入 `outputDir`，并只返回其路径。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

```yaml
- id: tool-media
  name: '@deepseek-ai/dsh-tool-media'
  config:
    baseURL: https://gateway.example.com/v1
    apiKeyEnv: DSH_MAAS_API_KEY
    imageModel: qwen-image-pro
    speechModel: indextts-2.5
    musicModel: minimax-music3
    videoModel: minimax-h3-fl2va
    outputDir: media-output
```

生成的文件写入 `outputDir`，该路径相对进程工作目录解析。异步的音乐和视频请求会轮询，直到完成或超过 `taskTimeoutMs`。

网关发布能力目录（`GET /v1/ov/capabilities`）时，`generate_image` 和 `generate_video` 从目录取模型和可接受的参数值，而不使用 `imageModel` 和 `videoModel`。目录按 key 读取，在内存中缓存 60 秒，并以 key 摘要为索引镜像到 `catalogCacheFile`（默认 `<DSH_HOME>/cache/ov-catalog.json`），因此网关中断时回退到该 key 上次看到的目录。设置 `catalog: false` 则只使用配置的模型。`videoDefaultDuration`（默认 5）是用户未指定时推荐的时长。

<a id="understand-the-implementation"></a>
## 了解实现

`generate_image` 和 `generate_speech` 是同步的：网关内联返回媒体，或返回一个会过期的 URL，工具在返回前下载它。`generate_music` 和 `generate_video` 提交任务并轮询其状态，因为这些模型要运行数分钟。音乐请求把提示词作为 `instructions` 发送，网关需要它来决定编曲。

语音和音乐返回 `{ path, model }`；网关的媒体 URL 会过期，因此工具在返回前写入文件。

图片和视频返回 `{ status, model, path?, choices? }`。用户说明且目录接受的参数按原样使用。有多个可接受值但无人说明的参数（图片：宽高比和分辨率；视频：比例、分辨率和时长），或用户说明但目录不接受的值，会产生 `status: needs_choice`，并附可接受的选项和推荐值；此时不生成任何内容，模型通过 `ask_user_question` 询问用户后再次调用。参考图决定画幅，因此图片编辑和由帧驱动的视频既不询问也不发送比例。视频把分辨率档位词作为最终的 `size` 发送，因此不高于生成阶段的档位会跳过聚合模型的超分阶段。

存在 [canvas](../canvas/README.zh.md) 服务时，图片和视频还接受画布节点 id：`generate_image` 接受 `referenceNodes`，`generate_video` 接受 `firstFrameNode`、`lastFrameNode` 和 `referenceNodes`。图片节点代表它的文件，组代表其中所有图片成员并按阅读顺序排列；未知节点、既不是图片也不是组的节点，或不含图片的组，都会在任何网关请求之前失败。调用成功后会添加一个结果节点，带有来自各输入的派生边，并返回 `nodeId`。文件已写入但节点未能添加时，结果保留 `path` 并报告 `canvasError`。没有该服务时，这些工具只处理文件并拒绝节点 id。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`generate_image`、`generate_video`、`generate_speech` 和 `generate_music` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-media)。schema 不指定模型，也不列出可接受的参数值；这些在调用时取自网关目录。这些工具不向系统提示词添加任何内容。

#### Token 影响

工具可见的每次请求都有固定的 schema 成本；描述和 schema 不随目录或画布变化。

#### KV Cache 影响

定义及其可见性不变时前缀稳定。

### 工具调用历史与结果

#### 模型看到什么

语音和音乐返回所写文件的 `path` 和 `model`。图片和视频返回 `status`、`model`，以及添加了画布节点时的 `path` 和 `nodeId`，或 `status` 为 `needs_choice` 时的 `choices`。文件已写入但未放上画布时，结果在 `path` 之外带有 `canvasError`。网关调用失败时显示网关自己的消息，其中指出缺失或无效的参数；缺少 key 时报告凭据引用以及如何存储它。

#### Token 影响

结果只有几个短字段。`needs_choice` 结果随待选参数的数量以及目录为每个参数接受的值而增长。生成的媒体字节不会进入结果。

#### KV Cache 影响

仅追加；调用和结果位于可复用的请求前缀之后，不会使已有的 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 语音合成需要参考音色来源；网关拒绝预设音色名，因此必须给模型一个音频 URL 或 data URI。
- 语音和音乐模型来自配置而不是发现；只有图片和视频遵循能力目录。
- 视频和音乐在工具预算内运行，因此很长的渲染需要更大的 `taskTimeoutMs`，而不是后台任务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
