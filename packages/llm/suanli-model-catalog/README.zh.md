---
description: "从网关列表刷新本产品的模型目录，并写入路由的 volatile `models` 字段，使选择器跟随平台变化而无需重启。"
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-model-catalog

[English](README.md) | 中文

## 概述

从网关列表刷新本产品的模型目录，并写入路由的 volatile `models` 字段，使选择器跟随平台变化而无需重启。

## 目录

- [为什么需要它](#why-this-exists)
- [刷新规则](#refresh-rules)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

## 为什么需要它 <a id="why-this-exists"></a>

路由的 `models` 是 volatile 配置，写入即对运行中的 provider 生效。本服务读取网关自己的 `GET <modelsPath>` 列表，与本部署已知的条目合并后写回该字段。这样网关侧上架模型后，选择器不必等构建期固定清单。

## 刷新规则 <a id="refresh-rules"></a>

- 列表决定成员与顺序；部署已知的条目保留 `contextWindow` 与 `inputModalities`，因为网关列表通常不带这些字段。
- `endpointTypes`（默认 `openai`）把图像、视频、音乐端点挡在聊天目录之外，直到选择器能驱动它们。
- 失败、未授权或空列表都不会清空目录：路由继续提供原有条目，`refresh()` 返回 `no-credential`、`unauthorized`、`unreachable` 或 `empty-listing`。
- 合并后的 id 与现有目录一致时不写入。

## 模型体验 <a id="model-experience"></a>

不涉及：目录只决定用户可以选择哪些模型，不进入提示词、工具 schema 或工具结果。

#### KV Cache 影响

无：目录变化不改变任何请求内容。

## 已知限制与后续工作 <a id="known-limitations-and-deferred-work"></a>

- 刷新后的目录写在 profile patch 里，而桌面品牌层每次启动都会用 `brand.json` 重写该文件，所以启动器层面的固定清单会在重启后回来，直到再次同步。
- 除聊天之外的能力分类（视频识别、文生图、首尾帧、参考生视频、音乐）尚未建模；平台已有的 `GET /v1/ov/capabilities` 是后续数据源。

<a id="dev-note"></a>
### 开发备注

目录刻意写在路由的 volatile `models` 字段上：这是唯一能让写入无需重启即生效的配置通道，也是「设置 → 模型」页面编辑的同一字段。桌面品牌层每次启动都会用 `brand.json` 重写 profile patch，所以本服务是「每次启动重新采用网关列表」的那一步；需要持久目录的部署应把合并结果存到品牌层不会重写的位置。
