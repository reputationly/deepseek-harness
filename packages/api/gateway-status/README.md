---
description: "Host Remote namespace reporting whether the model gateway this deployment routes through answers for the stored key, separating a refused key from an unreachable endpoint."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-gateway-status

English | [中文](README.zh.md)

## Summary

Host Remote namespace reporting whether the model gateway this deployment routes through answers for the stored key, separating a refused key from an unreachable endpoint.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

```yaml
- id: gateway-status
  name: '@deepseek-ai/dsh-api-gateway-status'
  config:
    baseURL: https://gateway.example/v1
    apiKeyEnv: GATEWAY_API_KEY
```

| Field | Meaning |
|---|---|
| `baseURL` | Gateway root that already carries its API prefix; `/models` is appended |
| `apiKeyEnv` | Credential reference resolved at every probe, so a replaced key reaches the next probe without a restart |
| `timeoutMs` | Request budget per probe (default 8000) |

`ctx.remote.gatewayStatus.read()` answers the cached observation without asking the gateway; `refresh()` probes now and shares any probe already in flight.

The observation separates the failures a person must tell apart: a key the gateway refuses (`key-rejected`, HTTP 401/403), an endpoint that cannot be reached at all (`unreachable`, with the transport message in `detail`), another refusal (`http-error`, with the status text), and no stored key (`no-key`). The key travels only in request headers and never reaches a return value or a log.

<a id="model-experience"></a>
## Model Experience

None, as the probe authenticates to the gateway itself and never enters a prompt, a tool schema, or a tool result.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Each refresh spends one authenticated `/models` request, so the polling cadence belongs to the client that asks.
- The namespace reports reachability and key acceptance only; it does not attest that a specific model is served or that a request would succeed.
- A deployment that configures no row for this package has no `gatewayStatus` namespace, leaving any client surface that injects it pending.

<a id="dev-note"></a>
### Dev Note

The probe repeats the check the Desktop first-run gate performs (`apps/desktop/src/gateway-probe.ts`); this package owns the cached observation and the Remote surface over it, so a browser can show the same verdict without reading credentials.
