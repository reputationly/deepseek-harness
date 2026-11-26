---
description: "本产品的侧栏品牌标志与文字标，以及空首页的标志，落在共享的侧栏与对话首页槽位上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-suanli

[English](README.md) | 中文

## 概述

提供侧栏与空首页渲染的产品标识：标志、带网关连接灯的文字标，以及首页标志。本包占用的三个槽位与上游品牌包相同，因此部署方在 `packages/bundle/web-app/cordis.patch.yml` 中组合其中一行来二选一。

文字标在构建期读取 `DSH_CLIENT_TITLE`，产品名因此是构建输入而不是源码文本。旁边的连接灯读取 Host 的 `gatewayStatus` 命名空间：已连接时每 30 秒查询一次，未连接时每 3 秒重试，侧栏折叠成窄条时不显示。

## 目录

- [占用的槽位](#occupied-slots)
- [模型体验](#model-experience)

## 占用的槽位 <a id="occupied-slots"></a>

| 槽位 | 组件 |
|---|---|
| `sidebar.brand.mark` | 按侧栏请求的尺寸渲染的标志 |
| `sidebar.brand.name` | 文字标，以及其后的网关连接灯 |
| `conversation.hero.brand.mark` | 空首页上的标志 |
| `settings.models.footer` | 目录刷新行：从本部署的网关同步选择器里的模型 |
| `tool.call.toolview`（`generate_image`、`generate_video`、`generate_music`、`generate_speech`） | 对话生成卡片：图片走附件画廊；视频和音乐在用户点击播放时按窗口从 Session 工作区读取，再用原生播放器展示 |

空首页的 `conversation.hero.frame` 图层保持空闲，因此标志背后不绘制任何装饰。

## 模型体验 <a id="model-experience"></a>

不涉及：本包只渲染浏览器呈现，不贡献提示词、工具 schema 或工具结果。

#### KV Cache 影响

无：本包渲染的内容不进入任何模型请求。

## 已知限制与后续工作

- 文字标使用 ui-theme 打包的「马善政」子集，只覆盖当前产品名五个字；改名需要重新生成子集，否则缺字会回退到系统字体。

### 开发备注

`ui-sidebar` 声明 `sidebar.brand.mark` 与 `sidebar.brand.name`，ui-conversation 声明 `conversation.hero.brand.mark`；本包把这四个槽位都填上，并让文字标这一行撑满，使连接灯落在与「新会话」按钮相同的右边缘。
