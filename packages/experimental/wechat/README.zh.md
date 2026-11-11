---
description: "通过腾讯 iLink 将微信私聊连接到本机 DSH agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-wechat

[English](README.md) | 中文

## 摘要

此 Host 服务通过腾讯 iLink 将一个微信所有者账号绑定到持久化 DSH 会话。它负责二维码登录、消息轮询、本地凭据存储、项目选择和 agent（智能体）回复投递。

## 使用本包

启用[微信 ClawBot 组合包](../wechat-bundle/README.zh.md)以安装 Host 服务和设置卡片。使用所有者账号，在「设置 → 微信」中扫描二维码。来自其他账号和群聊的消息会被忽略。

服务会将凭据、iLink 游标和最近会话元数据存储在 `$DSH_HOME/wechat` 下；凭据以 `0600` 权限写入。退出登录会删除凭据和游标。默认项目是 `$DSH_HOME/wechat/project`，下载的附件保存在该工作区的 `wechat-inbox/` 目录中。

每条私聊消息都会作为用户消息进入使用所配置默认模型和（如可用）默认 agent（智能体）预设的持久化 `workspace-write` 会话。新建和恢复的会话会附加到所属项目工作区。`/new`、`/list`、`/use <n>`、`/项目 [名称|序号]`（`/project`）、`/cancel` 和 `/help` 用于管理对话和项目。`wechat_send_file` 工具仅注册到微信来源的会话中；每轮结束时会自动发送生成的媒体文件。

## 模型体验

### 微信来源的 Session 轮次

#### 模型可见内容

入站文本和可用的语音转写会作为用户消息写入常规 Session 日志。下载的附件保存在所选工作区中，其相对路径会加入消息。WeChat 专用的 `wechat_send_file` 工具会把自身 schema 添加到这些会话中。

#### Token 影响

每条已处理消息都会使用选定模型执行常规 Session 轮次，并消耗工具 schema 的 token。本包不会单独发起模型请求。

#### KV Cache 影响

消息、附件路径和工具结果会使用常规 Session 历史记录及其通常的 KV Cache 行为。本包不会替换先前请求的 token，也不会添加独立 prompt。

## 已知限制与延期工作

- 仅支持已链接所有者的私聊消息。群聊和其他发送者会被忽略。
- Host 必须持续运行且电脑保持唤醒，才能接收消息。
- 此集成处于实验阶段，可用性和协议行为取决于腾讯 iLink。
