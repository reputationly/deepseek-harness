---
description: "把助手反馈及其脱敏后的对话快照转发到部署方 new-api 站点的 Host 命名空间，网关 key 始终留在 Host 进程内。"
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant-feedback

[English](README.md) | 中文

## 概述

把产品里的两个反馈入口——对某条助手回复的赞/踩，以及意见反馈弹窗——转发到 `POST <网关根地址>/api/assistant/feedback`。浏览器始终不携带网关 key：它调用 `remote.assistantFeedback.submit`，由本服务解析凭据、组装请求体、附带脱敏后的对话快照，并按失败类型返回一个代码。

赞/踩还会带上 `request_id`，即网关为那一次请求签发的标识，便于管理员在使用日志中定位到确切调用。

## 目录

- [请求字段](#request-fields)
- [对话快照](#conversation-snapshot)
- [配置](#config)
- [失败代码](#failure-codes)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

## 请求字段 <a id="request-fields"></a>

服务接受 `channel`（`rating` 或 `general`）、取值、用户选择的分类与正文、可选联系方式，以及定位信息（`sessionId`、`messageId`、`requestId`、`model`）。它把这些映射成站点字段名，补齐 Host 构建的 `client_version`，并使用调用方给出的 `platform`/`device_info`。缺少取值的 `rating` 与正文为空的 `general` 会在任何请求发出前被拒绝。

## 对话快照 <a id="conversation-snapshot"></a>

`context` 携带最近的对话轮次与被评价的回复，便于管理员看到用户当时看到的内容。快照来自活动以太 Session，受 `maxTurns`（默认 20）与 `maxContextBytes`（默认 60000）限制，每个字符串先脱敏：厂商 key、`Authorization` 头、Cookie 头以及带标签的口令都替换成 `***`，属性名本身是凭据名的对象属性整段遮蔽。超出字节上限时从最旧的轮次开始丢弃，并置 `truncated` 与 `truncatedReason`；绝不截断 JSON 本身。

## 配置 <a id="config"></a>

| 键 | 含义 |
|---|---|
| `baseURL` | 带 API 前缀的网关根地址；拼 `/api/assistant/feedback` 前会去掉 `/v1` |
| `apiKeyEnv` | 保存网关 key 的凭据引用，每次提交时解析 |
| `timeoutMs` | 单次请求预算（默认 15000） |
| `maxContextBytes` | 快照字节上限（默认 60000） |
| `maxTurns` | 应用字节上限前保留的最新轮次数（默认 20） |

## 失败代码 <a id="failure-codes"></a>

`not-configured`、`no-key`、`unauthorized`、`forbidden`、`rate-limited`、`too-large`、`rejected`、`unreachable`。每个都带一句可直接展示的文案；站点业务拒绝会把服务端自己的说明透传出来。

## 模型体验 <a id="model-experience"></a>

不涉及：反馈通过部署方的 HTTP 接口发出，不会进入任何模型请求。

#### KV Cache 影响

无：本包自身不向模型发送请求。

## 已知限制与后续工作 <a id="known-limitations-and-deferred-work"></a>


- **快照读取同步历史 API。** `Session.snapshotEvents()` 已被投影方案取代；本包沿用 `message-feedback` 的同一处窄豁免，等该领域的投影落地后一起迁移。
- **上报失败对用户不可见。** 反馈在本地已经落库、弹窗也随之关闭，失败只意味着部署方站点缺少这条记录。要让用户看到，需要弹窗目前还没有的 warning toast。
- **不带 `system_prompt` 与 `request_params`。** Host 不保留已完成调用的最终提示词与采样参数，站点文档也要求快照不得伪造这两项。

### 开发备注

- 服务读取被评价回复自己的 Session 事件拿 `providerRequestId`，而不是记最近一次请求——否则后续轮次会指向错误的调用。端点由桌面 profile patch 提供，因此同一个二进制可以指向另一个站点。