---
description: "Host Remote namespace that refreshes this product's model catalog from its gateway listing, keeps the gateway's capability catalog for the media workbench, and reports why either is in the state it is."
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-model-catalog

English | [中文](README.zh.md)

## Summary

Host Remote namespace that refreshes this product's model catalog from its gateway listing and writes it into the route's volatile `models` field, so the picker follows the platform without a restart. The same service owns the gateway's capability catalog: it keeps the last good generation for the media workbench, survives a restart through the storage domain, and answers `endpoint()` for consumers that call the gateway themselves.

## Table of Contents

- [Why this exists](#why-this-exists)
- [Refresh rules](#refresh-rules)
- [Capability classes](#capability-classes)
- [Media catalog](#media-catalog)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Why this exists

The route's `models` field is volatile configuration, so a write reaches the running provider immediately. This service reads the gateway's own `GET <modelsPath>` listing, merges it with the entries the deployment already knew, and writes the result into that field. A deployment whose gateway lists models can therefore keep its picker in step with the platform instead of a catalog pinned at build time.

## Refresh rules

- The listing decides membership and order; an entry the deployment already knew keeps its `contextWindow` and `inputModalities`, because a gateway listing usually omits them.
- `endpointTypes` (default `openai`) keeps image, video, and music endpoints out of the chat catalog until the picker can drive them.
- A failed, unauthorized, or empty listing never clears the catalog: the route keeps serving what it had, and `refresh()` reports `no-credential`, `unauthorized`, `unreachable`, or `empty-listing`.
- The write is skipped when the merged ids match the catalog in effect.
- The listing and the capability catalog are read independently: either may fail without changing what the other reports.

## Capability classes

`capabilities()` groups the entries of the last successful capability read into the product's classes: chat, image generation and editing (by `t2i` / `i2i`), video generation, first/last frame, reference-to-video (by `t2v` / `flf2v` / `r2va` and their siblings), music, and speech. A pair the platform names outside that vocabulary lands in `other` instead of disappearing. Classes a gateway does not declare stay absent, so the surface never claims a capability the platform cannot serve.

## Media catalog

`media()` returns `{ status, version, fetchedAt, entries }`. Entries keep every operation the gateway declares — the workbench renders images and video and reads the rest itself — and each carries its transport, task types, parameter schema, limits, delivery durations, and modes.

- `status` is `ready` for a catalog with at least one image or video entry, `empty` when a successful read carried none, `signed-out` without a credential, `unauthorized`, `kyc-required` (`403` whose body carries `kyc_required`), `rate-limited`, or `unreachable`; `loading` until the first read settles.
- A failed, empty, or unreadable read keeps the entries, version, and fetch time of the last good generation and changes only the status.
- Reads happen at startup (without delaying the Host), after `credentials/reference-updated` for this service's reference, and on `refresh()`; concurrent reads share one request.
- The last good generation is stored in the `suanli_media_catalog` storage domain and read back before the first request, so a restart without a network still renders a catalog. Without the storage domain the catalog stays in memory for the process.
- `suanli-model-catalog/media-updated` is emitted after a committed change to the status or version.
- A successful `/v1/models` result identical to the catalog in effect writes nothing: no settings write, no `llm/models-updated`.

## Model Experience

None, as the catalog decides which models a user may route to and never enters a prompt, a tool schema, or a tool result.

#### KV Cache effect

None: no request content changes with the catalog.

## Known Limitations and Deferred Work

- The refreshed model list lives in the profile patch, which the desktop brand layer rewrites from `brand.json` at every start, so a launcher-level pin returns after a restart until the row syncs again. Only the media catalog is stored elsewhere.
- A rejected legacy section whose entry no longer exists, or a read that cannot name a secret field, leaves that value untouched; the media catalog itself holds no credential.
- Recognition of video input (a chat model that accepts video) has no declaration in the gateway contract yet, so `vision.video` never appears.
- Classes derive from the entries of the last successful read, so they are empty until one succeeds.

<a id="dev-note"></a>
### Dev Note

The catalog lives in the route's volatile `models` field on purpose: that is the one configuration channel a write reaches without a restart, and it is the same field the Models settings page edits. The desktop brand layer rewrites the profile patch from `brand.json` at every start, so this service is the per-launch step that re-adopts the gateway's own listing. The capability catalog holds the full entry, parameters included, because the media workbench renders controls from it; a reduced projection would force a second reader of the same endpoint.

The stored generation is one JSON string inside the domain rather than a mirrored zod tree: the gateway extends entries with fields this product ignores, and a strict mirror would reject a catalog it could otherwise render.
