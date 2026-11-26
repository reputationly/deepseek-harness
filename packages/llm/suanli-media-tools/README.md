---
description: "Host tool plugin that generates images from chat with the image model the user selected, asking one question card for every missing or unsupported parameter."
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-media-tools

English | [中文](README.zh.md)

## Summary

Host tool plugin that generates images, videos, and music from chat with the models the user selected, asking one question card for every missing or unsupported parameter, and saving the result under the Session workspace's `generated/` directory.

## Table of Contents

- [Why this exists](#why-this-exists)
- [Parameter rules](#parameter-rules)
- [Result](#result)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Why this exists

A user who writes "生成一张小猫玩耍的图片" in a task conversation expects an image, not a detour into the 「创作」 workbench; the same holds for 「做一个 10 秒竖屏视频」 and 「生成一段轻快的钢琴曲」. Each tool reads its role (image, video, music, speech) from `suanliModels.roles()`, takes that model's entry from `suanliModels.media()`, submits through `suanliMedia`, and never touches the gateway key. `generate_image`, `generate_video`, `generate_music`, and `generate_speech` are each registered only while the catalog has a model for their role, and re-registered when the catalog or the role selection changes.

## Parameter rules

- Every enumerated parameter of the catalog entry must have a value before submission; the parameters come from the entry's `paramSchema`, not from model names.
- The user's own words are normalized first: `竖屏` → `9:16`, `横屏` → `16:9`, `方图` → `1:1`, `4k`/`超清4K` → `4K`, `10秒` → `10`.
- Missing and unsupported parameters are asked together in one question card. Each question lists the catalog's values with the default first; an unsupported value is named (`当前不支持「4K」`) and the supported values are listed.
- Arguments the model supplies directly are validated by the same rules, so a model that passes an unsupported value still produces the question card.
- A skipped or cancelled card submits nothing. A custom answer that is still unsupported is asked once more; a second unsupported answer fails the call.
- Reference images are workspace paths to PNG, JPEG, WebP, or GIF files, at most the entry's reference limit.
- Video parameters are aspect ratio, resolution, duration, and sound. A question lists at most six values; a long numeric set such as 1–20 seconds is described by its range (`最长 20`), and any supported value can be typed.
- The video mode follows the inputs: reference images use the `reference` mode, a first (and optional last) frame uses `first-last-frame` (`i2v` for one frame, `flf2v` for two), and no image uses `text-to-video`. The selected video model is used when it offers that mode; otherwise the first catalog model that offers it is used.
- Music asks whether the piece is instrumental (纯音乐 / 带人声) unless the call says so; lyrics go along only for a song and only when the entry takes `lyrics`.
- Video and music wait up to 20 and 10 minutes. Stopping the call cancels the gateway task.
- Artifacts are downloaded into a private staging directory and published under `generated/` with an exclusive create, then checked again; a `generated/` replaced by a link while the gateway was rendering receives nothing outside the workspace.

## Result

The model receives a JSON text with `status`, `model`, `parameters`, and `files`. The client card receives the private presentation metadata: prompt, model and its label, normalized parameters, saved paths, and an attachment reference per image when the `attachments` service exists. Video and music metadata carry `media` entries with the path and sniffed media type instead of images. A cancelled card returns `status: "cancelled"` with no files.

## Model Experience

### Tool schema

#### What the model sees

The [`generate_image`, `generate_video`, `generate_music`, and `generate_speech`](../../../docs/tool-catalog.md#deepseek-aidsh-suanli-media-tools) schemas, each while the catalog has a model for its role; absent otherwise.

#### Token effect

Fixed schemas of about 300 (image), 450 (video), and 200 (music) tokens per request while registered, plus one result of about 60 tokens per call.

#### KV Cache effect

The schema is prefix-stable. Registration changes only when a model of a role appears in or leaves the catalog, which invalidates the reusable prefix from the tool list onward once.

## Known Limitations and Deferred Work

- **Speech only through `/v1/audio/speech`** — `generate_speech` is offered only while the catalog lists a `maas-speech` entry, and synthesis is one synchronous call that a stop does not cancel at the gateway.
- **Review is advisory and partial** — with automatic review on, the selected vision model judges whether images and videos match the request and the card shows its verdict; it never regenerates by itself. Music and videos over 20 MiB are not reviewed, and a failed review call leaves the result unreviewed.
- **No video extension** — the task transport sends images only, so the `video-extension` mode, which needs a source video, is not offered from chat.
- **Resume needs the same call** — a video or song still rendering when the Host exits is kept in the `suanli_media_pending` storage domain for a day; the next call with the same workspace, model, prompt, inputs, and parameters resumes that task instead of submitting again, but nothing fetches it unprompted.
- **No progress percentage** — the call blocks until the file exists (about 36 s for a 2K image, minutes for a video), and the card shows an indeterminate progress state.
- **Outside a Session** — a call without an Agent saves into the process working directory instead of a Session workspace.
