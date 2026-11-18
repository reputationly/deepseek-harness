---
description: "Host Remote namespace that refreshes this product's model catalog from its gateway listing and writes it into the route's volatile models field, so the picker follows the platform without a restart."
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-model-catalog

English | [中文](README.zh.md)

## Summary

Host Remote namespace that refreshes this product's model catalog from its gateway listing and writes it into the route's volatile `models` field, so the picker follows the platform without a restart.

## Table of Contents

- [Why this exists](#why-this-exists)
- [Refresh rules](#refresh-rules)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Why this exists

The route's `models` field is volatile configuration, so a write reaches the running provider immediately. This service reads the gateway's own `GET <modelsPath>` listing, merges it with the entries the deployment already knew, and writes the result into that field. A deployment whose gateway lists models can therefore keep its picker in step with the platform instead of a catalog pinned at build time.

## Refresh rules

- The listing decides membership and order; an entry the deployment already knew keeps its `contextWindow` and `inputModalities`, because a gateway listing usually omits them.
- `endpointTypes` (default `openai`) keeps image, video, and music endpoints out of the chat catalog until the picker can drive them.
- A failed, unauthorized, or empty listing never clears the catalog: the route keeps serving what it had, and `refresh()` reports `no-credential`, `unauthorized`, `unreachable`, or `empty-listing`.
- The write is skipped when the merged ids match the catalog in effect.

## Capability classes

A refresh also reads `GET <capabilitiesPath>` (default `/v1/ov/capabilities`) and groups what the gateway declares into the product's classes: chat, image generation and editing (by `t2i` / `i2i`), video generation, first/last frame, reference-to-video (by `t2v` / `flf2v` / `r2va` and their siblings), music, and speech. A pair the platform names outside that vocabulary lands in `other` instead of disappearing. Classes a gateway does not declare stay absent, so the surface never claims a capability the platform cannot serve.

## Model Experience

None, as the catalog decides which models a user may route to and never enters a prompt, a tool schema, or a tool result.

#### KV Cache effect

None: no request content changes with the catalog.

## Known Limitations and Deferred Work

- The refreshed catalog lives in the profile patch, which the desktop brand layer rewrites from `brand.json` at every start, so a launcher-level pin returns after a restart until the row syncs again.
- Classes only appear when the platform's capability catalog declares them: this deployment's catalog currently has no `generate_image` entry and exposes the video family under aggregate model names, so text-to-image, image-to-image, and first/last frame stay absent until the platform is configured.
- Recognition of video input (a chat model that accepts video) has no declaration in the gateway contract yet, so `vision.video` never appears.
- The class list is per refresh; it is not persisted across restarts.

<a id="dev-note"></a>
### Dev Note

The catalog lives in the route's volatile `models` field on purpose: that is the one configuration channel a write reaches without a restart, and it is the same field the Models settings page edits. The desktop brand layer rewrites the profile patch from `brand.json` at every start, so this service is the per-launch step that re-adopts the gateway's own listing; a deployment that needs a durable catalog should persist the merged list somewhere the brand layer does not rewrite.
