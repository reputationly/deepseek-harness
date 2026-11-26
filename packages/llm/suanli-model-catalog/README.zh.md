---
description: "Host Remote 命名空间：读取本产品的 Hilo 模型目录，把对话模型写入路由，为媒体工作台保存生成条目，并报告每类角色使用的模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-model-catalog

[English](README.md) | 中文

## 概述

Host Remote 命名空间：读取网关的 Hilo 模型目录（`GET /api/v1/models/catalog`），把其中的对话模型写入路由的 volatile `models` 字段，选择器因此无需重启即可跟随平台。同一次读取还提供媒体工作台渲染的生成条目、六类模型角色及其默认值；最近一次成功读取的目录通过存储域在重启后保留，`endpoint()` 回答自己调用网关的消费方。

## 目录

- [为什么需要](#why-this-exists)
- [刷新规则](#refresh-rules)
- [能力分类](#capability-classes)
- [媒体目录](#media-catalog)
- [模型角色](#model-roles)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="why-this-exists"></a>
## 为什么需要

路由的 `models` 字段是 volatile 配置，写入立刻对运行中的提供方生效。本服务读取网关的 Hilo 目录，把其中 `text` 段与部署已知的条目合并，再把结果写入该字段。同一份目录也描述了所有生成模型，因此对话、多模态识别和生成对平台能力的认识不会互相矛盾。

<a id="refresh-rules"></a>
## 刷新规则

- 目录匿名读取：请求不带 `Authorization` 或 `x-api-key`，目录也不按 key 裁剪。key 无权使用的模型在调用时失败，并展示网关给出的原因。
- `text` 段决定对话目录的成员和顺序；部署已知的条目保留 `contextWindow`，`inputModalities` 按 `supportsImage`、`supportsVideo` 和 `supportsAudio` 生成。
- 失败、无法解析或为空的读取从不清空目录：路由继续提供已有内容，`refresh()` 报告 `unreachable` 或 `empty-listing`。
- 合并后的对话目录与当前一致时，不写设置，也不发 `llm/models-updated`。

<a id="capability-classes"></a>
## 能力分类

`capabilities()` 把最近一次成功读取的目录归入本产品的分类：对话、图片识别与视频识别（来自 `supportsImage` / `supportsVideo`）、图像生成与编辑（按 `t2i` / `i2i`）、视频生成、首尾帧、参考生视频（按 `t2v` / `flf2v` / `r2va` 及其同类），以及音乐和语音。该词表之外的组合落入 `other`，而不是消失。目录未声明的分类保持缺失，界面因此不会声称平台提供不了的能力。

<a id="media-catalog"></a>
## 媒体目录

`media()` 返回 `{ status, version, fetchedAt, entries }`。Hilo 的每个 `image`、`video`、`audio` 条目成为一个名为 `<operation>:<platformModel>` 的条目；`platformModel` 是请求使用的模型名，`params` 成为参数表，`maxRefs` 成为参考上限。

- `interfaceType` 决定条目的调用方式。`image` 为 `maas-image`，`video` 为 `maas-video`；`audio` 中 `maas-music` 是音乐，`maas-speech` 是语音。空值或未知值采用所在段的默认方式（`audio` 默认为音乐），未知值每个版本只记录一次日志。
- 视频玩法由 `image_mode` 的选项按网关的玩法规则（参考数量、来源、说明）推出，不匹配任何模型名。
- 目录至少有一个图像或视频条目时 `status` 为 `ready`；成功读取但没有这类条目时为 `empty`；没有凭据时为 `signed-out`（目录照常显示）；另有 `rate-limited` 和 `unreachable`；首次读取完成前为 `loading`。
- 失败、为空或无法解析的读取保留最近一次成功读取的条目、版本和读取时间，只改变状态。
- 读取发生在启动时（不拖慢 Host）、本服务凭据引用的 `credentials/reference-updated` 之后，以及 `refresh()` 时；并发读取共用一次请求。
- 最近一次成功读取的目录只在 `version` 变化时写入 `suanli_media_catalog` 存储域，并在首次请求前读回，因此断网重启后仍能渲染目录。没有存储域时，目录只在本进程内存中保留。
- 状态或版本的变化提交后发出 `suanli-model-catalog/media-updated`。

<a id="model-roles"></a>
## 模型角色

`roles()` 依次报告六类角色：`chat`、`vision`、`image`、`video`、`music` 和 `speech`。每类列出目录中的候选模型、用户的选择和兜底模型：对话取 `defaults.chat`，多模态识别取 `defaults.multimodal`，其余取第一个条目。没有候选的角色兜底为 `null`，界面显示为暂未开放。

- `vision` 的候选是 `supportsImage` 或 `supportsVideo` 为真的对话模型。
- `selectRole(role, model)` 为对话以外的角色保存选择，对话的选择由对话框的模型选择器负责；不在该角色候选中的模型会被拒绝。已保存的选择离开目录后读作 `null`。
- `preferences()` 和 `setAutoReview(enabled)` 保存是否审核生成的图片和视频；默认开启审核。
- 选择和偏好保存在 `suanli_model_roles` 存储域，不写设置；每次变化后发出 `suanli-model-catalog/roles-updated`。所有角色都用同一个网关 key 调用。

<a id="model-experience"></a>
## 模型体验

无：目录只决定用户可以路由到哪些模型，从不进入提示词、工具 schema 或工具结果。

#### KV Cache 影响

无：请求内容不随目录变化。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- 刷新后的模型列表存放在 profile patch 中，桌面品牌层每次启动都会按 `brand.json` 重写它；因此启动器层面的固定配置会在重启后回来，直到目录再次读取。媒体目录和角色选择保存在别处。
- Hilo 目录尚无语音调用协议；`maas-speech` 条目会列入 `speech`，调用要等网关的语音协议。
- 分类和角色来自最近一次成功读取，因此在首次读取成功前为空。

<a id="dev-note"></a>
### 开发备注

目录刻意放在路由的 volatile `models` 字段里：这是写入后无需重启即可生效的唯一配置通道，也是 Models 设置页编辑的同一个字段。桌面品牌层每次启动都会按 `brand.json` 重写 profile patch，所以本服务就是每次启动重新采用网关自身目录的那一步。生成条目保留完整参数表，因为媒体工作台据此渲染控件；缩减后的投影会迫使同一端点出现第二个读取方。

存储的目录是存储域中的一个 JSON 字符串，而不是镜像出来的 zod 结构：网关会给条目扩展本产品忽略的字段，严格镜像会拒绝一份本可以渲染的目录。
