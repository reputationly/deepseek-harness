---
description: "Host Remote namespace that reads this product's Hilo model catalog, puts its chat models in the route, keeps its generation entries for the media workbench, and reports the model each role uses."
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-model-catalog

English | [中文](README.zh.md)

## Summary

Host Remote namespace that reads the gateway's Hilo model catalog (`GET /api/v1/models/catalog`) and writes its chat models into the route's volatile `models` field, so the picker follows the platform without a restart. The same read supplies the generation entries the media workbench renders, the six model roles, and their defaults; the last good generation survives a restart through the storage domain, and `endpoint()` answers consumers that call the gateway themselves.

## Table of Contents

- [Why this exists](#why-this-exists)
- [Refresh rules](#refresh-rules)
- [Capability classes](#capability-classes)
- [Media catalog](#media-catalog)
- [Model roles](#model-roles)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Why this exists

The route's `models` field is volatile configuration, so a write reaches the running provider immediately. This service reads the gateway's Hilo catalog, merges its `text` section with the entries the deployment already knew, and writes the result into that field. One catalog also describes every generation model, so chat, multimodal understanding, and generation never disagree about what the platform offers.

## Refresh rules

- The catalog is read anonymously: the request carries no `Authorization` or `x-api-key`, and the catalog is not trimmed to the key. A model the key may not use fails when it is called, with the gateway's reason.
- The `text` section decides chat membership and order; an entry the deployment already knew keeps its `contextWindow`, and `inputModalities` are `text` plus `image` when `supportsImage` is set, the input kinds a chat route accepts; `supportsVideo` only makes a model a vision candidate.
- A failed, unreadable, or empty read never clears the catalog: the route keeps serving what it had, and `refresh()` reports `unreachable` or `empty-listing`.
- The settings write and `llm/models-updated` are skipped when the merged chat catalog matches the one in effect.

## Capability classes

`capabilities()` groups the last good generation into the product's classes: chat, vision of images and of video (from `supportsImage` / `supportsVideo`), image generation and editing (by `t2i` / `i2i`), video generation, first/last frame, reference-to-video (by `t2v` / `flf2v` / `r2va` and their siblings), music, and speech. A pair outside that vocabulary lands in `other` instead of disappearing. Classes the catalog does not declare stay absent, so the surface never claims a capability the platform cannot serve.

## Media catalog

`media()` returns `{ status, version, fetchedAt, entries }`. Each Hilo `image`, `video`, and `audio` item becomes one entry named `<operation>:<platformModel>`; `platformModel` is the model a request names, `params` become the parameter schema, and `maxRefs` the reference limit.

- `interfaceType` selects how an item is called. `image` is `maas-image` and `video` is `maas-video`; in `audio`, `maas-music` is music and `maas-speech` is speech. An empty or unknown value takes its section's default (music for `audio`), and an unknown value is logged once per version.
- Video plays derive from the `image_mode` options with the gateway's play rules (reference counts, sources, notes), so no model name is matched.
- `status` is `ready` for a catalog with at least one image or video entry, `empty` when a successful read carried none, `signed-out` without a credential (the catalog is still shown), `rate-limited`, or `unreachable`; `loading` until the first read settles.
- A failed, empty, or unreadable read keeps the entries, version, and fetch time of the last good generation and changes only the status.
- Reads happen at startup (without delaying the Host), after `credentials/reference-updated` for this service's reference, and on `refresh()`; concurrent reads share one request.
- The last good generation is stored in the `suanli_media_catalog` storage domain only when its `version` changes, and read back before the first request, so a restart without a network still renders a catalog. Without the storage domain the catalog stays in memory for the process.
- `suanli-model-catalog/media-updated` is emitted after a committed change to the status or version.

## Model roles

`roles()` reports six roles in order: `chat`, `vision`, `image`, `video`, `music`, and `speech`. Each lists its candidates from the catalog, the user's choice, and a fallback: `defaults.chat` for chat, `defaults.multimodal` for vision, and the first entry otherwise. A role without candidates has a `null` fallback and is shown as not available.

- `vision` candidates are the chat models with `supportsImage` or `supportsVideo`.
- `selectRole(role, model)` stores a choice for any role but chat, whose choice the conversation's model picker owns; a model outside the role's candidates is rejected. A stored choice that leaves the catalog reads as `null`.
- `preferences()` and `setAutoReview(enabled)` hold whether generated images and videos are reviewed; review is on by default.
- Choices and preferences live in the `suanli_model_roles` storage domain, not in settings, and `suanli-model-catalog/roles-updated` follows each change. Every role is called with the one gateway key.

## Model Experience

None, as the catalog decides which models a user may route to and never enters a prompt, a tool schema, or a tool result.

#### KV Cache effect

None: no request content changes with the catalog.

## Known Limitations and Deferred Work

- The refreshed model list lives in the profile patch, which the desktop brand layer rewrites from `brand.json` at every start, so a launcher-level pin returns after a restart until the catalog is read again. The media catalog and role choices are stored elsewhere.
- The Hilo catalog carries no speech transport yet; a `maas-speech` item is listed under `speech`, and calling it waits for the gateway's speech contract.
- Classes and roles derive from the last good generation, so they are empty until one read succeeds.

<a id="dev-note"></a>
### Dev Note

The catalog lives in the route's volatile `models` field on purpose: that is the one configuration channel a write reaches without a restart, and it is the same field the Models settings page edits. The desktop brand layer rewrites the profile patch from `brand.json` at every start, so this service is the per-launch step that re-adopts the gateway's own catalog. The generation entries keep the full parameter table because the media workbench renders controls from it; a reduced projection would force a second reader of the same endpoint.

The stored generation is one JSON string inside the domain rather than a mirrored zod tree: the gateway extends items with fields this product ignores, and a strict mirror would reject a catalog it could otherwise render.
