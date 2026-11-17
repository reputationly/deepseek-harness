---
description: "本产品的侧栏品牌标志与文字标，以及空首页的标志，落在共享的侧栏与对话首页槽位上。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-suanli

[English](README.md) | 中文

## 概述

提供侧栏与空首页渲染的产品标识：标志、文字标和首页标志。本包占用的三个槽位与上游品牌包相同，因此部署方在 `packages/bundle/web-app/cordis.patch.yml` 中组合其中一行来二选一。

文字标在构建期读取 `DSH_CLIENT_TITLE`，产品名因此是构建输入而不是源码文本。

## 占用的槽位

| 槽位 | 组件 |
|---|---|
| `sidebar.brand.mark` | 按侧栏请求的尺寸渲染的标志 |
| `sidebar.brand.name` | 文字标 |
| `conversation.hero.brand.mark` | 空首页上的标志 |

空首页的 `conversation.hero.frame` 图层保持空闲，因此标志背后不绘制任何装饰。

## 模型体验

本包只贡献浏览器呈现：不涉及工具、提示词、token 或缓存。它的 Host 半边是空的 `apply`，因此 Loader 行存在但没有 Host 侧行为。
