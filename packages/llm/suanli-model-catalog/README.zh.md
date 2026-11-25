---
description: "从网关列表刷新本产品的模型目录，为媒体工作台保留网关的能力目录，并说明两者的当前状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-model-catalog

[English](README.md) | 中文

## 概述

从网关列表刷新本产品的模型目录，并写入路由的 volatile `models` 字段，使选择器跟随平台变化而无需重启。同一个服务还负责网关的能力目录：为媒体工作台保留最近一次成功的目录，通过存储域跨重启保留，并通过 `endpoint()` 回答自行调用网关的使用方。

## 目录

- [为什么需要它](#why-this-exists)
- [刷新规则](#refresh-rules)
- [能力分类](#capability-classes)
- [媒体目录](#media-catalog)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="why-this-exists"></a>
## 为什么需要它

路由的 `models` 字段是 volatile 配置，写入立刻对运行中的提供方生效。本服务读取网关自己的 `GET <modelsPath>` 列表，与部署已知的条目合并，再把结果写入该字段。因此，网关会列出模型的部署可以让选择器跟随平台变化，而不必把目录固定在构建产物里。

<a id="refresh-rules"></a>
## 刷新规则

- 列表决定成员与顺序；部署已知的条目保留其 `contextWindow` 与 `inputModalities`，因为网关列表通常不包含它们。
- `endpointTypes`（默认 `openai`）把图像、视频和音乐端点挡在对话目录之外，直到选择器能驱动它们。
- 失败、未授权或空的列表从不清空目录：路由继续提供已有条目，`refresh()` 报告 `no-credential`、`unauthorized`、`unreachable` 或 `empty-listing`。
- 合并后的 id 与当前目录一致时不写入。
- 列表与能力目录各自独立读取：任意一方失败都不改变另一方报告的内容。

<a id="capability-classes"></a>
## 能力分类

`capabilities()` 把最近一次成功读取的条目归入本产品的分类：对话、图像生成与编辑（按 `t2i` / `i2i`）、视频生成、首尾帧、参考生视频（按 `t2v` / `flf2v` / `r2va` 及其同类），以及音乐和语音。平台用该词表之外的名字声明的组合会落入 `other`，而不是消失。网关未声明的分类保持缺失，界面因此不会声称平台提供不了的能力。

<a id="media-catalog"></a>
## 媒体目录

`media()` 返回 `{ status, version, fetchedAt, entries }`。条目保留网关声明的全部操作——工作台渲染图像与视频，其余由各自的使用方读取——每条携带传输方式、任务类型、参数表、上限、交付时长与玩法。

- `status`：目录中至少有一个图像或视频条目时为 `ready`；成功读取但一个都没有时为 `empty`；没有凭据时为 `signed-out`；其余为 `unauthorized`、`kyc-required`（响应体带 `kyc_required` 的 `403`）、`rate-limited` 或 `unreachable`；首次读取完成前为 `loading`。
- 失败、空或无法解析的读取保留上一份成功目录的条目、版本与读取时间，只改变状态。
- 读取发生在启动时（不阻塞 Host）、本服务凭据的 `credentials/reference-updated` 之后，以及 `refresh()` 被调用时；并发读取共用一个请求。
- 最近一份成功目录存放在 `suanli-media-catalog` 存储域中，并在首次请求之前读回，因此断网重启仍能渲染目录。没有存储域时，目录只存在于本进程内存中。
- `suanli-model-catalog/media-updated` 在状态或版本提交之后发出。
- `/v1/models` 结果与当前目录完全一致时不写入任何内容：不写设置，也不发 `llm/models-updated`。

<a id="model-experience"></a>
## 模型体验

无：目录决定用户可路由到哪些模型，从不进入提示、工具 schema 或工具结果。

#### KV Cache 影响

无：目录变化不改变任何请求内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 刷新后的模型列表存放在 profile 补丁里，而桌面端品牌层每次启动都会用 `brand.json` 重写该补丁，因此启动器层面的固定值会重启后回归，直到该行再次同步。只有媒体目录存在别处。
- 对应条目已不存在的旧版设置分段，或无法判断密钥字段的读取，其值保持原样；媒体目录本身不含凭据。
- 网关契约尚未声明"接受视频输入的对话模型"，因此 `vision.video` 永远不会出现。
- 分类来自最近一次成功读取的条目，因此在那之前为空。

<a id="dev-note"></a>
### 开发备注

目录刻意放在路由的 volatile `models` 字段里：那是写入无需重启即可生效的唯一配置通道，也是「模型」设置页编辑的同一字段。桌面端品牌层每次启动都会用 `brand.json` 重写 profile 补丁，所以本服务是重新采用网关自身列表的那一步。能力目录保留完整条目（含参数），因为媒体工作台据此渲染控件；只保留裁剪后的投影会迫使同一个端点出现第二个读取方。

存入存储域的是一段 JSON 字符串，而不是镜像的 zod 结构：网关会给条目追加本产品忽略的字段，严格镜像会拒绝一份它本可渲染的目录。
