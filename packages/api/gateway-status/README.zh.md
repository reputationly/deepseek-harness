---
description: "Host Remote 命名空间：报告本部署调用所经的模型网关是否接受已存密钥，并区分密钥被拒与端点点不可达。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-gateway-status

[English](README.md) | 中文

## 概述

Host Remote 命名空间：报告本部署调用所经的模型网关是否接受已存密钥，并区分密钥被拒与端点点不可达。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

```yaml
- id: gateway-status
  name: '@deepseek-ai/dsh-api-gateway-status'
  config:
    baseURL: https://gateway.example/v1
    apiKeyEnv: GATEWAY_API_KEY
```

| 字段 | 含义 |
|---|---|
| `baseURL` | 已带 API 前缀的网关根地址；探测时追加 `/models` |
| `apiKeyEnv` | 每次探测重新解析的凭据引用，替换密钥后下次探测即生效 |
| `timeoutMs` | 单次探测的请求预算（默认 8000） |

`ctx.remote.gatewayStatus.read()` 直接返回缓存的观测结果，不访问网关；`refresh()` 立即探测，并与进行中的探测合并。

观测结果区分必须让人分清的失败：网关拒绝密钥（`key-rejected`，HTTP 401/403）、完全连不上端点（`unreachable`，`detail` 带传输层原因）、其它拒绝（`http-error`，带状态文本），以及尚未保存密钥（`no-key`）。密钥只出现在请求头，不进入返回值或日志。

<a id="model-experience"></a>
## 模型体验

无。探测本身向网关认证，从不进入提示词、工具 schema 或工具结果。

#### KV Cache effect

模型请求前缀不变。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 每次刷新消耗一次带认证的 `/models` 请求，轮询节奏由发起方客户端决定。
- 该命名空间只报告可达性与密钥是否被接受，不保证某个模型可用，也不预测单次请求一定成功。
- 未为本包配置行的部署没有 `gatewayStatus` 命名空间，注入它的客户端界面会一直处于 pending。

<a id="dev-note"></a>
### 开发备注

探测复用 Desktop 首启门禁所用的同一项检查（`apps/desktop/src/gateway-probe.ts`）；本包拥有缓存观测结果及其上的 Remote 界面，使浏览器无需读取凭据即可显示同一结论。
