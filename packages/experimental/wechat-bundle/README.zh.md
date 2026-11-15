---
description: "通过腾讯 iLink 将微信私聊绑定到本机 DSH agent。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-wechat-bundle

[English](README.md) | 中文

<a id="summary"></a>

## 概述

实验性微信 ClawBot 组合包通过腾讯 iLink 将微信私聊连接到本机 DSH agent（智能体）。在**设置 → 微信**绑定账号后，直接向 ClawBot 发消息。选中的 DSH 工作区及会话保存在本机，桌面应用中仍可访问。

组合包组合 Host 集成及其 Client 设置卡片，不支持群聊。

<a id="table-of-contents"></a>

## 目录

- [使用本组合包](#use-this-bundle)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-bundle"></a>
## 使用本组合包

在插件管理器安装或启用 **WeChat ClawBot**。打开**设置 → 微信**，选择**添加微信**，使用该私聊所属账号扫描显示的二维码。

使用微信时保持桌面应用运行并防止电脑休眠。在聊天中发送 `/help` 查看可用命令。

<a id="model-experience"></a>

## 模型体验

### 组合包组成

#### 模型看到什么

组合包自身不添加提示词或工具 schema。[`cordis.patch.yml`](cordis.patch.yml)选择 [Host 集成](../wechat/README.zh.md)及[设置卡片](../client-ui-wechat/README.zh.md)；微信消息与工具由 Host 持有。

#### Token 影响

组合包不额外增加提示词／schema token；消息与工具开销由所选 Host 贡献持有。

#### KV Cache 影响

组合操作不重写 Session 历史或缓存请求前缀；后续消息遵循 Host 集成。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 本集成为实验性能力，可用性及协议行为取决于腾讯 iLink。
- 仅处理所绑定所有者账号的私聊，忽略群消息。
- 本机 Host 必须保持运行才能接收消息。

<a id="dev-note"></a>
### 开发备注

[Loader 组合测试](tests/loader-composition.host.spec.ts)通过正式配置检查本组合包。
