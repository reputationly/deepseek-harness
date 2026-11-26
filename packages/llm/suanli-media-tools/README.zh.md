---
description: "Host 工具插件：在对话里用用户选定的生图模型生成图片，缺少或不支持的参数用一张问题卡一次问完。"
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-media-tools

[English](README.md) | 中文

## 概述

Host 工具插件：在对话里用用户选定的生图模型生成图片，缺少或不支持的参数用一张问题卡一次问完，结果保存在 Session 工作区的 `generated/` 目录下。

## 目录

- [为什么需要它](#why-this-exists)
- [参数规则](#parameter-rules)
- [结果](#result)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

## 为什么需要它 <a id="why-this-exists"></a>

用户在任务对话里写「生成一张小猫玩耍的图片」，期望直接得到图片，而不是转去「创作」工作台。本工具从 `suanliModels.roles()` 读取生图角色，从 `suanliModels.media()` 取该模型的 `generate_image` 条目，经 `suanliMedia` 提交，不接触网关密钥。只有目录里有生图模型时才注册；目录或角色选择变化时重新注册。

## 参数规则 <a id="parameter-rules"></a>

- 提交前，目录条目的每个枚举参数都必须有值；参数来自条目的 `paramSchema`，不看模型名。
- 先规整用户原话：`竖屏` → `9:16`，`横屏` → `16:9`，`方图` → `1:1`，`4k`/`超清4K` → `4K`，`10秒` → `10`。
- 缺少和不支持的参数在一张问题卡里一起问。每题列出目录的取值，默认值排第一；不支持的值会点名（`当前不支持「4K」`）并列出支持的值。
- 模型直接传入的参数按同样规则校验，模型传了不支持的值也会弹问题卡。
- 跳过或取消问题卡时不提交。自定义答案仍不支持时再问一次；第二次仍不支持则调用失败。
- 参考图是工作区内的 PNG、JPEG、WebP 或 GIF 路径，数量不超过条目的参考图上限。

## 结果 <a id="result"></a>

模型收到一段 JSON 文本，含 `status`、`model`、`parameters` 和 `files`。客户端卡片收到私有展示元数据：提示词、模型及其显示名、规整后的参数、保存路径，以及 `attachments` 服务存在时每张图的附件引用。取消问题卡时返回 `status: "cancelled"`，不含文件。

## 模型体验 <a id="model-experience"></a>

### 工具 schema <a id="tool-schema"></a>

#### 模型看到什么 <a id="what-the-model-sees"></a>

目录里有生图模型时的 [`generate_image`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-suanli-media-tools) schema；没有时不出现。

#### Token 影响 <a id="token-effect"></a>

注册期间每次请求固定约 300 token 的 schema，每次调用另有约 60 token 的结果。

#### KV Cache 影响 <a id="kv-cache-effect"></a>

schema 前缀稳定。只有生图模型在目录中出现或消失时注册才变化，此时从工具列表起的可复用前缀失效一次。

## 已知限制与后续工作 <a id="known-limitations-and-deferred-work"></a>

- **只支持生图**：生视频、生音乐、生语音工具和多模态需求审核还不在本包内，对话里目前只能生成图片。
- **没有进度百分比**：调用会阻塞到图片生成完成（2K 约 36 秒），卡片显示不确定进度。
- **Session 之外**：没有 Agent 的调用保存到进程工作目录，而不是 Session 工作区。
