---
description: "通过腾讯 iLink 将微信私聊连接到本机 DSH agent。"
kind: "package-reference"
---

# @deepseek-ai/dsh-wechat

[English](README.md) | 中文

<a id="summary"></a>

## 概述

将一个微信私聊连接到 Agent，在选定项目中保留对话历史。扫码登录后，可在该聊天中接收回复和生成文件。Host 必须持续运行；其他账号和群聊消息不会处理。

<a id="table-of-contents"></a>

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

启用[微信 ClawBot 组合包](../wechat-bundle/README.zh.md)以安装 Host 服务和设置卡片。使用所有者账号，在「设置 → 微信」中扫描二维码。来自其他账号和群聊的消息会被忽略。

服务会将凭据、iLink 游标和最近会话元数据存储在 `$DSH_HOME/wechat` 下；POSIX 文件使用 `0600` 权限。退出登录会删除凭据和游标。默认项目是 `$DSH_HOME/wechat/project`，下载的附件保存在该工作区的 `wechat-inbox/` 目录中。

每条私聊消息都会作为用户消息进入使用所配置默认模型和（如可用）默认 agent（智能体）预设的持久化 `workspace-write` 会话。新建和恢复的会话会附加到所属项目工作区。`/new`、`/list`、`/use <n>`、`/项目 [名称|序号]`（`/project`）、`/cancel` 和 `/help` 用于管理对话和项目。`wechat_send_file` 工具仅注册到微信来源的会话中；每轮结束时会自动发送生成的媒体文件。

本地状态契约 `WechatStatus` 与 `WechatSnapshot` 定义于 [src/types.ts](src/types.ts)。`watchStatus` 向设置卡片流式传递脱敏后的连接状态；登录凭据仍由 Host 存储持有。

<a id="model-experience"></a>

## 模型体验

### 微信来源的 Session 轮次

#### 模型可见内容

入站文本和可用的语音转写会作为用户消息写入常规 Session 日志。下载的附件保存在所选工作区中，其相对路径会加入消息。WeChat 专用的 `wechat_send_file` 工具会把自身 schema 添加到这些会话中。

#### Token 影响

每条已处理消息都会使用选定模型执行常规 Session 轮次，并消耗工具 schema 的 token。本包不会单独发起模型请求。

#### KV Cache 影响

消息、附件路径和工具结果追加到 Session 历史。启用微信专属工具可能改变 schema 前缀；其余缓存复用遵循所选供应商与保留的历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持已链接所有者的私聊消息。群聊和其他发送者会被忽略。
- Host 必须持续运行且电脑保持唤醒，才能接收消息。
- 此集成处于实验阶段，可用性和协议行为取决于腾讯 iLink。

<a id="dev-note"></a>

### 开发备注

协议请求位于 [src/protocol.ts](src/protocol.ts)；持久化本地记录位于 [src/storage.ts](src/storage.ts)。构造函数第二个参数是空的部署配置；集成测试的运行时依赖覆盖放在第三个参数中。
