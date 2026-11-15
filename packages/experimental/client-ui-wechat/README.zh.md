---
description: "在设置中管理微信 ClawBot 连接与默认项目。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-wechat

[English](README.md) | 中文

<a id="summary"></a>

## 概述

本 Client 包在设置中添加本地化的微信卡片，显示扫码登录及连接状态，提供重连、断开与退出登录操作，并允许用户选择默认工作区。在 Desktop 中，版本化电源桥接可用时，卡片还显示共用的保持唤醒偏好。

<a id="table-of-contents"></a>

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

安装[微信 ClawBot 组合包](../wechat-bundle/README.zh.md)，将本卡片与 Host 服务组合。卡片位于设置 → 微信。登录凭据与消息处理仍由 Host 服务持有。

<a id="model-experience"></a>

## 模型体验

### 微信设置

#### 模型看到什么

无。`wechat` 设置卡片不提供模型上下文或工具。[组件测试](tests/components.client.spec.tsx)覆盖其设置操作。

#### Token 影响

零。本包不创建模型请求。

#### KV Cache 影响

卡片不读取或修改 Session 历史及缓存请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 卡片需要匹配的微信 Host 服务，不能独立作为登录客户端。
- 登录和消息投递依赖腾讯 iLink 及持续可用的 Host。

<a id="dev-note"></a>
### 开发备注

[挂载测试](tests/mount.client.spec.ts)负责贡献注册及清理。
