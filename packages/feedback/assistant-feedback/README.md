---
description: "Host namespace that relays assistant feedback and its redacted conversation snapshot to the deployment's new-api site, keeping the gateway key in the Host process."
kind: "package-reference"
---

# @deepseek-ai/dsh-assistant-feedback

English | [中文](README.zh.md)

## Summary

Relays the product's two feedback entries — a rating on one assistant reply and the general feedback dialog — to `POST <gateway root>/api/assistant/feedback`. The browser never carries the gateway key: it calls `remote.assistantFeedback.submit`, and this service resolves the credential, builds the payload, attaches the redacted conversation snapshot, and reports one code per failure.

A rating also carries `request_id`, the identifier the gateway issued for that reply's request, so administrators can search their request log for the exact call.

## Table of Contents

- [Request fields](#request-fields)
- [Conversation snapshot](#conversation-snapshot)
- [Config](#config)
- [Failure codes](#failure-codes)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Request fields

The service accepts `channel` (`rating` or `general`), the verdict, the user's category and text, the optional contact, and the targets (`sessionId`, `messageId`, `requestId`, `model`). It maps them to the site's field names, adding `client_version` from the Host build and `platform`/`device_info` from the caller. A `rating` submission without a verdict and a `general` submission with empty text are refused before any request leaves the process.

## Conversation snapshot

`context` carries the recent turns and the rated reply so an administrator can see what the user saw. It is built from the live Session, bounded to `maxTurns` (default 20) and `maxContextBytes` (default 60000), and every string is redacted first: provider keys, `Authorization` headers, cookie headers, and labelled secrets become `***`, and object properties whose name names a credential are masked whole. Turns are dropped oldest-first to fit the byte ceiling, which sets `truncated` and `truncatedReason`; the JSON itself is never truncated.

## Config

| Key | Meaning |
|---|---|
| `baseURL` | Gateway root that carries its API prefix; `/v1` is stripped before `/api/assistant/feedback` |
| `apiKeyEnv` | Credential reference holding the gateway key, resolved at every submission |
| `timeoutMs` | Request budget (default 15000) |
| `maxContextBytes` | Snapshot byte ceiling (default 60000) |
| `maxTurns` | Newest turns kept before the byte ceiling applies (default 20) |

## Failure codes

`not-configured`, `no-key`, `unauthorized`, `forbidden`, `rate-limited`, `too-large`, `rejected`, `unreachable`. Each carries one sentence a surface shows unchanged; a site business rejection passes its own message through.

## Model Experience

None, as feedback submissions leave through the deployment's HTTP endpoint and never reach a model request.

#### KV Cache effect

None: the package sends no request of its own to a model.

## Known Limitations and Deferred Work


- **Snapshot reads the synchronous history API.** `Session.snapshotEvents()` is deprecated in favor of a projection; this package takes the same narrow exemption `message-feedback` takes, and moves when that domain's projection exists.
- **A failed relay is silent.** The remark is already durable locally and the dialog closes on that record, so the deployment site simply lacks the submission. Surfacing it needs a warning toast the dialog does not have yet.
- **`system_prompt` and `request_params` are absent.** The Host does not retain the assembled prompt or the sampling parameters of a finished call, and the site documents that a snapshot must not fabricate them.

### Dev Note

- The service reads the rated reply's own Session event for `providerRequestId` rather than tracking the latest request, because a later turn would name the wrong call. The deployment supplies the endpoint through the desktop profile patch, so the same binary can point at another site.