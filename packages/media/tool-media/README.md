---
description: "Generate images, speech, music, and video, or edit local audio and video with FFmpeg and place the results on a project canvas."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-media

English | [中文](README.zh.md)

## Summary

Agents can generate images, speech, music, and video through an OpenAI-compatible gateway, then edit local audio and video with FFmpeg. Generated and edited media can be added to the current project canvas. Local editing requires usable FFmpeg tools; generation requires configured gateway credentials.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package in a composition when a session needs media generation or local FFmpeg editing with project-canvas results.

### When to choose it

Choose this package when an agent needs gateway image, speech, music, or video generation, or local audio/video editing. Use [the canvas package](../canvas/README.md) when a session only needs direct project-canvas operations.

### Minimal configuration

```yaml
- id: tool-media
  name: '@deepseek-ai/dsh-tool-media'
  config:
    baseURL: https://gateway.example.com/v1
    apiKeyEnv: DSH_MAAS_API_KEY
```

Generated files land in `outputDir` resolved against the process working directory. Asynchronous music and video requests poll until they finish or `taskTimeoutMs` elapses.

When the gateway publishes a capability catalog (`GET /v1/ov/capabilities`), `generate_image` and `generate_video` take their models and accepted parameter values from it instead of `imageModel` and `videoModel`. The catalog is read per key, cached in memory for 60 seconds, and mirrored to `catalogCacheFile` (default `<DSH_HOME>/cache/ov-catalog.json`) under a key digest, so an outage falls back to the last catalog that key saw. Set `catalog: false` to use the configured models only. `videoDefaultDuration` (default 5) is the length recommended when the user names none.

FFmpeg and FFprobe default to executables on `PATH`. Desktop packages for macOS arm64 and Windows x64 include both binaries; other deployments must install them or set their paths. Set `fontFile` to an absolute font path when using non-ASCII text with `drawtext`.

Use `merge_videos` to concatenate clips. For complex edits, load the bundled `media-editing` skill first. The `ffmpeg` tool writes its result directly to the canvas, so do not call `canvas_edit` to add the same node; `-f null` runs a dry check without writing a file or canvas node.

The table highlights the gateway and editing fields. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-media) lists every accepted field.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | required | Gateway root, including its API prefix. |
| `apiKeyEnv` | `DSH_MAAS_API_KEY` | Credential reference resolved for each gateway request. |
| `outputDir` | `media-output` | Directory for generated and edited files. |
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | Local executables used for media editing. |
| `editTimeoutMs` | `600000` | Time limit for one local edit. |
| `fontFile` | unset | Absolute font path for non-ASCII `drawtext`. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Media generation and local editing use separate execution paths and share media placement on the project canvas.

<details>
<summary>Implementation internals — click to expand</summary>

`generate_image` and `generate_speech` are synchronous: the gateway returns the media inline or as an expiring URL that the tool downloads before returning. `generate_music` and `generate_video` submit a task and poll its status, because those models run for minutes. Music requests send the prompt as `instructions`, which the gateway requires to decide the arrangement.

Speech and music return `{ path, model }` and add the file as an audio canvas node when possible; the gateway's media URLs expire, so the file is written before the tool returns.

Image and video return `{ status, model, path?, choices? }`. A parameter the user stated and the catalog accepts is used as is. A parameter with more than one accepted value that nobody stated (image: aspect ratio and resolution; video: ratio, resolution, and duration), or a stated value the catalog does not accept, produces `status: needs_choice` with the accepted options and a recommendation; nothing is generated, and the model asks the user through `ask_user_question` before calling again. Reference images fix the canvas, so image edits and frame-driven videos never ask for or send a ratio. Video sends the resolution tier word as the final `size`, so a tier at or below the generation stage skips an aggregate model's upscale stage.

When the [canvas](../canvas/README.md) service is present, image and video also accept canvas node ids: `generate_image` takes `referenceNodes`, and `generate_video` takes `firstFrameNode`, `lastFrameNode`, and `referenceNodes`. An image node stands for its file and a group for all of its image members in reading order; an unknown node, a node that is not an image or a group, or a group without images fails before any gateway request. A successful call adds a result node with derivation edges from its sources and returns `nodeId`. When the file was written but the node could not be added, the result keeps `path` and reports `canvasError`. Without the service the tools work on files only and reject node ids.

`ffmpeg` accepts local file paths or project-relative paths and writes one generated video, audio, or image file. `media_probe` reports container and stream metadata before editing. `merge_videos` probes its inputs, normalizes their video dimensions and frame rates, and supplies silent audio where a clip has no audio or a shorter track. A placed output links to explicit input node ids and canvas nodes whose paths match the input files. If the canvas is unavailable, the output file remains usable and the result reports the placement error.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Registers generation tools and the optional editing-skill provider. |
| [`src/visual-tools.ts`](src/visual-tools.ts) | Generates gateway media and places outputs on the canvas. |
| [`src/edit-tools.ts`](src/edit-tools.ts) | Registers and executes FFmpeg, merge, and probe tools. |
| [`src/ffmpeg-guards.ts`](src/ffmpeg-guards.ts) | Restricts FFmpeg arguments and configures drawtext fonts. |
| [`src/ffmpeg.ts`](src/ffmpeg.ts) | Runs FFmpeg and FFprobe with limits and lifecycle cleanup. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover canvas behavior, common editing recipes, and tool integration.

- [Canvas package](../canvas/README.md) — project media nodes and derivation edges.
- [Media-editing recipes](assets/media-editing/SKILL.md) — probes and common FFmpeg operations.
- [Tool authoring guide](../../../docs/cookbook/adding-a-tool.md) — schemas, execution results, and Web presentation.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The model sees the generated [`generate_image`, `generate_video`, `generate_speech`, `generate_music`, `ffmpeg`, `merge_videos`, and `media_probe` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-media). The generation schemas name no model and list no accepted parameter values; those come from the gateway catalog at call time. The tools add nothing to the system prompt.

#### Token effect

Fixed schema cost on every request where the tools are visible; the descriptions and schemas do not vary with the catalog or the canvas.

#### KV Cache effect

Prefix-stable while the definitions and their visibility are unchanged.

### Tool-call history and results

#### What the model sees

Speech and music return the written file's `path` and `model`, with optional `nodeId` or `canvasError`. Image and video return `status`, `model`, and either `path` with `nodeId` when a canvas node was added, or `choices` when `status` is `needs_choice`. Editing tools return the output `path` and optional placement fields; `media_probe` returns container and stream details, while an FFmpeg dry run returns its stderr summary without a file. A failed gateway call surfaces the gateway's own message, which names the missing or invalid parameter; a missing key reports the credential reference and how to store it.

#### Token effect

A result is a few short fields. A `needs_choice` result grows with the number of parameters to choose and the values the catalog accepts for each. Generated media bytes never enter the result.

#### KV Cache effect

Append-only; calls and results follow the reusable request prefix and do not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Media generation and local editing require separate gateway and executable dependencies.

- Speech synthesis requires a reference voice source; the gateway rejects preset voice names, so the model must be given an audio URL or data URI.
- Speech and music models are configuration rather than discovery; only image and video follow the capability catalog.
- Video and music run inside the tool budget, so very long renders need a larger `taskTimeoutMs` rather than a background job.
- Local editing requires usable FFmpeg and FFprobe executables. Non-ASCII `drawtext` requires a configured font file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
