---
description: "生成图片、语音、音乐和视频，或使用 FFmpeg 剪辑本地音视频并把结果放到项目画布。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-media

[English](README.md) | 中文

## 概述

Agent 可通过 OpenAI 兼容网关生成图片、语音、音乐和视频，也可使用 FFmpeg 剪辑本地音视频。生成和剪辑的媒体可添加到当前项目画布。本地剪辑需要可用的 FFmpeg 程序；媒体生成需要配置网关凭据。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

当会话需要媒体生成或本地 FFmpeg 剪辑并将结果放到项目画布时，可在组合中挂载此包。

### 何时选择此包

当 Agent 需要通过网关生成图片、语音、音乐或视频，或剪辑本地音视频时，选择此包。若会话只需直接操作项目画布，请使用 [canvas 包](../canvas/README.zh.md)。

### 技能

`skillsRoot` 指向「装着若干技能子目录」的目录，每个子目录里有一个 `SKILL.md`，其 frontmatter 的 `name` 与目录名一致；默认值是本包的 `assets/`。内置 `media-editing`（本地 FFmpeg 配方）、`studio-pipeline`（制作流程）、`studio-craft`（剧本、分镜与提示词写法）和 `studio-layout`（画布布局约定）。frontmatter 名字与目录名不一致的目录会在加载时报错。

### 最小配置

```yaml
- id: tool-media
  name: '@deepseek-ai/dsh-tool-media'
  config:
    baseURL: https://gateway.example.com/v1
    apiKeyEnv: DSH_MAAS_API_KEY
```

生成的文件写入 `outputDir`，该路径相对进程工作目录解析。异步的音乐和视频请求会轮询，直到完成或超过 `taskTimeoutMs`。

网关发布能力目录（`GET /v1/ov/capabilities`）时，`generate_image` 和 `generate_video` 从目录取模型和可接受的参数值，而不使用 `imageModel` 和 `videoModel`。目录按 key 读取，在内存中缓存 60 秒，并以 key 摘要为索引镜像到 `catalogCacheFile`（默认 `<DSH_HOME>/cache/ov-catalog.json`），因此网关中断时回退到该 key 上次看到的目录。设置 `catalog: false` 则只使用配置的模型。`videoDefaultDuration`（默认 5）是用户未指定时推荐的时长。

FFmpeg 和 FFprobe 默认从 `PATH` 查找。macOS arm64 和 Windows x64 的 Desktop 安装包自带这两个程序；其他部署必须安装它们或设置对应路径。使用非 ASCII 的 `drawtext` 时，需将 `fontFile` 设为绝对字体路径。

拼接片段请使用 `merge_videos`。复杂剪辑先加载内置 `media-editing` skill。`ffmpeg` 工具会直接把结果添加到画布，不要再调用 `canvas_edit` 添加同一节点；`-f null` 会执行试运行，不写入文件或画布节点。

下表列出网关和剪辑相关字段。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-media)列出了所有可接受字段。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | 必填 | 包含 API 前缀的网关根 URL。 |
| `apiKeyEnv` | `DSH_MAAS_API_KEY` | 每次网关请求时解析的凭据引用。 |
| `outputDir` | `media-output` | 生成和剪辑文件的目录。 |
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | 用于媒体剪辑的本地程序。 |
| `editTimeoutMs` | `600000` | 单次本地剪辑的时限。 |
| `fontFile` | 未设置 | 用于非 ASCII `drawtext` 的绝对字体路径。 |

-----

<a id="understand-the-implementation"></a>
## 了解实现

媒体生成和本地剪辑使用独立执行路径，并共享项目画布的媒体放置流程。

<details>
<summary>实现细节 — 点击展开</summary>

`generate_image` 和 `generate_speech` 是同步的：网关内联返回媒体，或返回一个会过期的 URL，工具在返回前下载它。`generate_music` 和 `generate_video` 提交任务并轮询其状态，因为这些模型要运行数分钟。音乐请求把提示词作为 `instructions` 发送，网关需要它来决定编曲。

语音和音乐返回 `{ path, model }`，并在可用时把文件添加为画布音频节点；网关的媒体 URL 会过期，因此工具在返回前写入文件。

图片和视频返回 `{ status, model, path?, choices? }`。用户说明且目录接受的参数按原样使用。有多个可接受值但无人说明的参数（图片：宽高比和分辨率；视频：比例、分辨率和时长），或用户说明但目录不接受的值，会产生 `status: needs_choice`，并附可接受的选项和推荐值；此时不生成任何内容，模型通过 `ask_user_question` 询问用户后再次调用。参考图决定画幅，因此图片编辑和由帧驱动的视频既不询问也不发送比例。视频把分辨率档位词作为最终的 `size` 发送，因此不高于生成阶段的档位会跳过聚合模型的超分阶段。

存在 [canvas](../canvas/README.zh.md) 服务时，图片和视频还接受画布节点 id：`generate_image` 接受 `referenceNodes`，`generate_video` 接受 `firstFrameNode`、`lastFrameNode` 和 `referenceNodes`。图片节点代表它的文件，组代表其中所有图片成员并按阅读顺序排列；未知节点、既不是图片也不是组的节点，或不含图片的组，都会在任何网关请求之前失败。调用成功后会添加一个结果节点，带有来自各输入的派生边，并返回 `nodeId`。文件已写入但节点未能添加时，结果保留 `path` 并报告 `canvasError`。没有该服务时，这些工具只处理文件并拒绝节点 id。

`ffmpeg` 接受本地文件路径或项目相对路径，并写入一个视频、音频或图片文件。`media_probe` 会在剪辑前报告容器和流元数据。`merge_videos` 会探测输入、统一视频尺寸和帧率，并为缺少音轨或音轨较短的片段补充静音。结果节点会连接显式输入节点 id，以及路径与输入文件匹配的画布节点。画布不可用时，文件仍然可用，结果会报告放置错误。

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 注册生成工具和可选的 skill provider。 |
| [`src/skills.ts`](src/skills.ts) | 枚举 `skillsRoot` 下的技能目录并注册一个 provider。 |
| [`src/visual-tools.ts`](src/visual-tools.ts) | 通过网关生成媒体并将产物放到画布。 |
| [`src/edit-tools.ts`](src/edit-tools.ts) | 注册并执行 FFmpeg、拼接和探测工具。 |
| [`src/ffmpeg-guards.ts`](src/ffmpeg-guards.ts) | 限制 FFmpeg 参数并配置 drawtext 字体。 |
| [`src/ffmpeg.ts`](src/ffmpeg.ts) | 运行 FFmpeg 和 FFprobe，管理限制与生命周期清理。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面介绍画布行为、常见剪辑配方和工具集成。

- [Canvas 包](../canvas/README.zh.md) — 项目媒体节点和派生边。
- [音视频剪辑配方](assets/media-editing/SKILL.md) — 探测和常见 FFmpeg 操作。
- [Studio pipeline](assets/studio-pipeline/SKILL.md)、[craft](assets/studio-craft/SKILL.md) 与 [layout](assets/studio-layout/SKILL.md) — 制作流程、分镜写法与画布布局约定。
- [工具编写指南](../../../docs/cookbook/adding-a-tool.zh.md) — schema、执行结果和 Web 呈现。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`generate_image`、`generate_video`、`generate_speech`、`generate_music`、`ffmpeg`、`merge_videos` 和 `media_probe` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-media)。生成工具的 schema 不指定模型，也不列出可接受的参数值；这些在调用时取自网关目录。工具不向系统提示词添加任何内容。

#### Token 影响

工具可见的每次请求都有固定的 schema 成本；描述和 schema 不随目录或画布变化。

#### KV Cache 影响

定义及其可见性不变时前缀稳定。

### 工具调用历史与结果

#### 模型看到什么

语音和音乐返回所写文件的 `path` 和 `model`，并可选返回 `nodeId` 或 `canvasError`。图片和视频返回 `status`、`model`，以及添加了画布节点时的 `path` 和 `nodeId`，或 `status` 为 `needs_choice` 时的 `choices`。剪辑工具返回输出 `path` 和可选的画布放置字段；`media_probe` 返回容器和流信息，FFmpeg 试运行则只返回 stderr 摘要，不生成文件。网关调用失败时显示网关自己的消息，其中指出缺失或无效的参数；缺少 key 时报告凭据引用以及如何存储它。

#### Token 影响

结果只有几个短字段。`needs_choice` 结果随待选参数的数量以及目录为每个参数接受的值而增长。生成的媒体字节不会进入结果。

#### KV Cache 影响

仅追加；调用和结果位于可复用的请求前缀之后，不会使已有的 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

媒体生成和本地剪辑依赖不同的网关与本地程序。

- 语音合成需要参考音色来源；网关拒绝预设音色名，因此必须给模型一个音频 URL 或 data URI。
- 语音和音乐模型来自配置而不是发现；只有图片和视频遵循能力目录。
- 视频和音乐在工具预算内运行，因此很长的渲染需要更大的 `taskTimeoutMs`，而不是后台任务。
- 本地剪辑需要可用的 FFmpeg 和 FFprobe 程序。非 ASCII 的 `drawtext` 需要配置字体文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
