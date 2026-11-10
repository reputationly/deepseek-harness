---
description: "侧栏底部的模型网关连接灯：一个圆点加状态文案，悬停显示失败原因，数据来自 Host 的 gatewayStatus Remote 命名空间。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-gateway-status

[English](README.md) | 中文

## 概述

侧栏底部的模型网关连接灯：一个圆点加状态文案，悬停显示失败原因，数据来自 Host 的 `gatewayStatus` Remote 命名空间。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

该行无需配置：它报告的端点与凭据由 Host 侧 [`dsh-api-gateway-status`](../../api/gateway-status/README.zh.md) 行提供。侧栏底部把连接灯叠在「设置」上方，折叠成窄栏时只显示圆点。

| 状态 | 文案 | 悬停提示 |
|---|---|---|
| 密钥被接受 | 已连接 | 同文案 |
| 未存密钥 | 未连接 | 请到 设置 → 模型 添加 |
| 密钥被拒（401/403） | 未连接 | 网关不认这个 API Key |
| 传输失败 | 未连接 | 连不上网关，附失败原因 |
| 其它拒绝 | 未连接 | 网关返回，附状态文本 |

点击圆点立即重新探测。已连接时每 30 秒重读一次缓存结果；未连接时每 3 秒真正探测一次，因此换了密钥或网络恢复后无需重启即可显示。

<a id="model-experience"></a>
## 模型体验

无。该指示器只读取一条 Host 观测结果，从不进入提示词、工具 schema 或工具结果。

#### KV Cache effect

模型请求前缀不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 连接灯报告的是部署配置的网关，不一定是某个会话当前选中的提供方。
- 只有挂载该行的界面会显示连接灯；CLI 没有底部区域。
- Host 未挂载 `gatewayStatus` 命名空间时，该行会一直等待服务，而不是显式报错。

<a id="dev-note"></a>
### 开发备注

`ui-sidebar` 在「设置」上方声明了空的 `sidebar.footer.action` 插槽，本行填充它；点击手势通过轮询所用的同一 Host 命名空间重新探测。
