---
description: "Host tool plugin that generates images from chat with the image model the user selected, asking one question card for every missing or unsupported parameter."
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-media-tools

English | [中文](README.zh.md)

## Summary

Host tool plugin that generates images from chat with the image model the user selected, asking one question card for every missing or unsupported parameter, and saving the result under the Session workspace's `generated/` directory.

## Table of Contents

- [Why this exists](#why-this-exists)
- [Parameter rules](#parameter-rules)
- [Result](#result)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Why this exists

A user who writes "生成一张小猫玩耍的图片" in a task conversation expects an image, not a detour into the 「创作」 workbench. The tool reads the image role from `suanliModels.roles()`, takes that model's `generate_image` entry from `suanliModels.media()`, submits through `suanliMedia`, and never touches the gateway key. It is registered only while the catalog has an image model, and re-registered when the catalog or the role selection changes.

## Parameter rules

- Every enumerated parameter of the catalog entry must have a value before submission; the parameters come from the entry's `paramSchema`, not from model names.
- The user's own words are normalized first: `竖屏` → `9:16`, `横屏` → `16:9`, `方图` → `1:1`, `4k`/`超清4K` → `4K`, `10秒` → `10`.
- Missing and unsupported parameters are asked together in one question card. Each question lists the catalog's values with the default first; an unsupported value is named (`当前不支持「4K」`) and the supported values are listed.
- Arguments the model supplies directly are validated by the same rules, so a model that passes an unsupported value still produces the question card.
- A skipped or cancelled card submits nothing. A custom answer that is still unsupported is asked once more; a second unsupported answer fails the call.
- Reference images are workspace paths to PNG, JPEG, WebP, or GIF files, at most the entry's reference limit.

## Result

The model receives a JSON text with `status`, `model`, `parameters`, and `files`. The client card receives the private presentation metadata: prompt, model and its label, normalized parameters, saved paths, and an attachment reference per image when the `attachments` service exists. A cancelled card returns `status: "cancelled"` with no files.

## Model Experience

### Tool schema

#### What the model sees

The [`generate_image`](../../../docs/tool-catalog.md#deepseek-aidsh-suanli-media-tools) schema while the catalog has an image model; it is absent otherwise.

#### Token effect

A fixed schema of about 300 tokens per request while registered, plus one result of about 60 tokens per call.

#### KV Cache effect

The schema is prefix-stable. Registration changes only when an image model appears in or leaves the catalog, which invalidates the reusable prefix from the tool list onward once.

## Known Limitations and Deferred Work

- **Image only** — video, music, and speech tools and the multimodal requirement review are not part of this package yet, so a conversation can only generate images.
- **No progress percentage** — the call blocks until the image exists (about 36 s for 2K), and the card shows an indeterminate progress state.
- **Outside a Session** — a call without an Agent saves into the process working directory instead of a Session workspace.
