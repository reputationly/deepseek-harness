---
description: "把助手反馈及其脱敏后的对话快照转发到部署方 new-api 站点的 Host 命名空间，网关 key 始终留在 Host 进程内。"
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant-feedback

[English](README.md) | 中文

## 概述

把产品里的两个反馈入口——对某条助手回复的赞/踩，以及意见反馈弹窗——转发到 `POST <网关根地址>/api/assistant/feedback`。浏览器始终不携带网关 key：它调用 `remote.assistantFeedback.submit`，由本服务解析凭据、组装请求体、附带脱敏后的对话快照，并按失败类型返回一个代码。

## 请求字段

服务接受 `channel`（`rating` 或 `general`）、取值、用户选择的分类与正文、可选联系方式，以及定位信息（`sessionId`、`messageId`、`requestId`、`model`）。它把这些映射成站点字段名，补齐 Host 构建的 `client_version`，并使用调用方给出的 `platform`/`device_info`。缺少取值的 `rating` 与正文为空的 `general` 会在任何请求发出前被拒绝。

## 对话快照

`context` 携带最近的对话轮次与被评价的回复，便于管理员看到用户当时看到的内容。快照来自活动以太 Session，受 `maxTurns`（默认 20）与 `maxContextBytes`（默认 60000）限制，每个字符串先脱敏：厂商 key、`Authorization` 头、Cookie 头以及带标签的口令都替换成 `***`，属性名本身是凭据名的对象属性整段遮蔽。超出字节上限时从最旧的轮次开始丢弃，并置 `truncated` 与 `truncatedReason`；绝不截断 JSON 本身。

## 配置

| 键 | 含义 |
|---|---|
| `baseURL` | 带 API 前缀的网关根地址；拼 `/api/assistant/feedback` 前会去掉 `/v1` |
| `apiKeyEnv` | 保存网关 key 的凭据引用，每次提交时解析 |
| `timeoutMs` | 单次请求预算（默认 15000） |
| `maxContextBytes` | 快照字节上限（默认 60000） |
| `maxTurns` | 应用字节上限前保留的最新轮次数（默认 20） |

## 失败代码

`not-configured`、`no-key`、`unauthorized`、`forbidden`、`rate-limited`、`too-large`、`rejected`、`unreachable`。每个都带一句可直接展示的文案；站点业务拒绝会把服务端自己的说明透传出来。

## 模型体验

本包不新增任何工具、提示词或上下文：模型看不到反馈提交。上传的快照脱敏后从 Session 日志派生，并且不会写回日志。

## 已知限制与后续工作

- **没有 `request_id`。** 模型 transport 只在错误路径读 `x-oneapi-request-id`，要在成功路径带上它，就得给已持久化的助手消息增加字段。因此反馈目前用 `session_id`、`message_id` 与时间定位这次调用；捕获该响应头需要先改 `llm`/`llm-deepseek` 的 Session 事件格式。
- **快照读取同步历史 API。** `Session.snapshotEvents()` 已被投影方案取代；本包沿用 `message-feedback` 的同一处窄豁免，等该领域的投影落地后一起迁移。
- **上报失败对用户不可见。** 反馈在本地已经落库、弹窗也随之关闭，失败只意味着部署方站点缺少这条记录。要让用户看到，需要弹窗目前还没有的 warning toast。
- **不带 `system_prompt` 与 `request_params`。** Host 不保留已完成调用的最终提示词与采样参数，站点文档也要求快照不得伪造这两项。
