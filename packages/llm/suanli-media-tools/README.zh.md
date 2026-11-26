---
description: "Host 工具插件：在对话里用用户选定的生图模型生成图片，缺少或不支持的参数用一张问题卡一次问完。"
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-media-tools

[English](README.md) | 中文

## 概述

Host 工具插件：在对话里用用户选定的模型生成图片、视频和音乐，缺少或不支持的参数用一张问题卡一次问完，结果保存在 Session 工作区的 `generated/` 目录下。

## 目录

- [为什么需要它](#why-this-exists)
- [参数规则](#parameter-rules)
- [结果](#result)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

## 为什么需要它 <a id="why-this-exists"></a>

用户在任务对话里写「生成一张小猫玩耍的图片」，期望直接得到图片，而不是转去「创作」工作台；「做一个 10 秒竖屏视频」「生成一段轻快的钢琴曲」也一样。每个工具从 `suanliModels.roles()` 读取自己的角色（生图、生视频、生音乐），从 `suanliModels.media()` 取该模型的条目，通过 `suanliMedia` 提交，从不接触网关 key。`generate_image`、`generate_video`、`generate_music` 只在目录里有对应角色的模型时注册，目录或角色选择变化时重新注册。

## 参数规则 <a id="parameter-rules"></a>

- 提交前，目录条目的每个枚举参数都必须有值；参数来自条目的 `paramSchema`，不看模型名。
- 先规整用户原话：`竖屏` → `9:16`，`横屏` → `16:9`，`方图` → `1:1`，`4k`/`超清4K` → `4K`，`10秒` → `10`。
- 缺少和不支持的参数在一张问题卡里一起问。每题列出目录的取值，默认值排第一；不支持的值会点名（`当前不支持「4K」`）并列出支持的值。
- 模型直接传入的参数按同样规则校验，模型传了不支持的值也会弹问题卡。
- 跳过或取消问题卡时不提交。自定义答案仍不支持时再问一次；第二次仍不支持则调用失败。
- 参考图是工作区内的 PNG、JPEG、WebP 或 GIF 路径，数量不超过条目的参考图上限。
- 视频参数有宽高比、分辨率、时长和声音。每题最多列 6 个取值；1–20 秒这样的长数字区间按范围描述（`最长 20`），任何支持的值都可以手填。
- 视频玩法按输入决定：有参考图用 `reference`，有首帧（可加尾帧）用 `first-last-frame`（一帧为 `i2v`，两帧为 `flf2v`），没有图片用 `text-to-video`。选定的视频模型支持该玩法时用它，否则用目录里第一个支持的模型。
- 生音乐在调用没说明时询问是否纯音乐（纯音乐 / 带人声）；只有带人声且条目接受 `lyrics` 时才传歌词。
- 视频最多等 20 分钟，音乐最多等 10 分钟。停止调用会取消网关任务。
- 产物先下载到私有暂存目录，再以独占创建的方式发布到 `generated/` 并再次检查；渲染期间 `generated/` 被换成链接时，工作区外收不到任何文件。

## 结果 <a id="result"></a>

模型收到一段 JSON 文本，含 `status`、`model`、`parameters` 和 `files`。客户端卡片收到私有展示元数据：提示词、模型及其显示名、规整后的参数、保存路径，以及 `attachments` 服务存在时每张图的附件引用。取消问题卡时返回 `status: "cancelled"`，不含文件。 视频和音乐的元数据用 `media` 条目代替图片，含路径和识别出的媒体类型。

## 模型体验 <a id="model-experience"></a>

### 工具 schema <a id="tool-schema"></a>

#### 模型看到什么 <a id="what-the-model-sees"></a>

目录里有对应角色模型时的 [`generate_image`、`generate_video`、`generate_music`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-suanli-media-tools) schema；没有时不出现。

#### Token 影响 <a id="token-effect"></a>

注册期间每次请求固定约 300（生图）、450（生视频）、200（生音乐）token 的 schema，每次调用另有约 60 token 的结果。

#### KV Cache 影响 <a id="kv-cache-effect"></a>

schema 前缀稳定。只有某个角色的模型在目录中出现或消失时注册才变化，此时从工具列表起的可复用前缀失效一次。

## 已知限制与后续工作 <a id="known-limitations-and-deferred-work"></a>

- **还没有语音**：生语音要等目录出现 `maas-speech` 条目。
- **审核只是提示，且不全覆盖**：开启自动审核时，所选多模态识别模型判断图片和视频是否符合要求，卡片显示结论，不会自动重新生成。音乐和超过 20 MiB 的视频不审核，审核调用失败时结果保持未审核。
- **不支持视频续写**：任务通道只能传图片，需要源视频的 `video-extension` 玩法不从对话提供。
- **重启后不续取**：Host 退出时仍在渲染的视频不会再取回；网关任务继续运行，调用报告中断。
- **没有进度百分比**：调用会阻塞到文件生成完成（2K 图片约 36 秒，视频需数分钟），卡片显示不确定进度。
- **Session 之外**：没有 Agent 的调用保存到进程工作目录，而不是 Session 工作区。
