---
description: "Sidebar footer connection light for the model gateway: one dot plus its state, with the failure reason in the tooltip, over the Host gatewayStatus Remote namespace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-gateway-status

English | [中文](README.zh.md)

## Summary

Sidebar footer connection light for the model gateway: one dot plus its state, with the failure reason in the tooltip, over the Host `gatewayStatus` Remote namespace.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The row needs no configuration: the Host row [`dsh-api-gateway-status`](../../api/gateway-status/README.md) supplies the endpoint and credential it reports on. The sidebar footer stacks the light above Settings, and the collapsed rail shows the dot alone.

| State | Label | Tooltip |
|---|---|---|
| answered key | 已连接 / Connected | the label |
| no stored key | 未连接 / Not connected | add a key in Settings → Models |
| refused key (401/403) | 未连接 | the gateway rejected this key |
| transport failure | 未连接 | cannot reach the gateway, with the failure text |
| other refusal | 未连接 | the gateway answered, with its status text |

Pressing the light probes immediately. While connected it re-reads the cached observation every 30 seconds; while disconnected it probes every 3 seconds, so a restored key or a recovered network shows without a restart.

<a id="model-experience"></a>
## Model Experience

None, as the light reads one Host observation and never enters a prompt, a tool schema, or a tool result.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The light reports the gateway the deployment configures, which is not necessarily the provider a given Session selected.
- Only surfaces that mount this row show a light; the CLI has no footer.
- A deployment whose Host mounts no `gatewayStatus` namespace leaves this row waiting for that service rather than failing loudly.

<a id="dev-note"></a>
### Dev Note

`ui-sidebar` declares the empty `sidebar.footer.action` slot above Settings; this row fills it, and the press gesture re-probes through the same Host namespace the poll reads.
