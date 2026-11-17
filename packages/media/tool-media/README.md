---
description: "Generate images, speech, music, and video, or edit local audio and video with FFmpeg and place the results on a project canvas."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-media

English | [中文](README.zh.md)

## Summary

Agents can generate images, speech, music, and video through an OpenAI-compatible gateway, then edit local audio and video with FFmpeg. Generated and edited media can be added to the current project canvas. The Host must provide local `subprocess` execution through `@deepseek-ai/dsh-subprocess-local`. Local editing requires usable FFmpeg tools; generation requires configured gateway credentials.

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

### Skills

`skillsRoot` names the directory that holds one subdirectory per bundled skill, each with a `SKILL.md` whose frontmatter `name` matches its directory; the default is this package's `assets/`. It ships `media-editing` (local FFmpeg recipes), `studio-pipeline` (the production flow), `studio-craft` (script, storyboard, and prompt writing), and `studio-layout` (canvas layout conventions). A directory whose frontmatter names another skill fails at load.

### Minimal configuration

```yaml
- id: tool-media
  name: '@deepseek-ai/dsh-tool-media'
  config:
    baseURL: https://gateway.example.com/v1
    apiKeyEnv: DSH_MAAS_API_KEY
```

Generated files land in `outputDir` resolved against the process working directory. Asynchronous music and video requests poll until they finish or `taskTimeoutMs` elapses.

In Canvas Sessions, all four `generate_*` tools create their output node before submission and use the same persistent runner as `canvas_generate`; this requires a Host jobs provider and controller. Visual generation requires a populated project bible. A successful tool result means the version is attached and the node has left queued/running state. File-only deployments without a canvas keep standalone generation.

Opening the canvas reconciles `.canvas/<episode-file>.media/` checkpoints: completed files are attached idempotently and known remote task ids are polled without a new submission. Preparation failures can be retried, and a submission the gateway itself answered with an HTTP error was not accepted: a 5xx stays retryable, a 4xx is not retryable, and neither sets `recoveryRequired`. An unknown paid submission — an interrupted connection or a failed download after the gateway accepted the request — or local cancellation of a remote request requires provider-history verification. Changing generation parameters does not clear `recoveryRequired`. Keep checkpoints and `outputDir` in backups. See the [upgrade guide](../../../docs/upgrade-guide/v0.2.2-rc.1/canvas-media-recovery/guide.md) for custom compositions.

Host shutdown preserves known remote tasks and retained files for recovery on reopening. Explicitly cancelled checkpoints remain terminal, including records created before shutdown and user cancellation were distinguished.

Windows drive paths, UNC paths, and `file:` URLs are local media references. Local voice samples are uploaded as data URIs; HTTP(S) and data voice references are passed through. FFmpeg inputs accept local files only. When a browser cannot decode a recorded video, `media.videoPreview` prepares a WebM/VP9/Opus cache in `.canvas/previews/` using local FFmpeg, preserving the original and making no cloud request.

When the gateway publishes a capability catalog (`GET /v1/ov/capabilities`), `generate_image` and `generate_video` take their models and accepted parameter values from it instead of `imageModel` and `videoModel`; an operation the catalog does not list uses the configured `imageModel` or `videoModel`. Audio requests also validate model availability, modes, and transport against this catalog; a failed lookup without a usable cached catalog refuses audio submission. The catalog is read per key, cached in memory for 60 seconds, and mirrored to `catalogCacheFile` (default `<DSH_HOME>/cache/ov-catalog.json`) under a key digest, so an outage falls back to the last catalog that key saw. Set `catalog: false` to use the configured models only. `videoDefaultDuration` (default 5) is the length recommended when the user names none.

`canvas_generate` plans and runs the media of named canvas nodes: one storyboard becomes one keyframe image and one video node per segment, generated keyframes first and then every segment video, with scenes running in parallel. A segment that continues the next picture uses that segment's keyframe as its last frame. An existing node that already covers a segment is reused, and a segment with a manual first frame keeps it instead of a generated keyframe. A run returns as soon as its jobs are registered, with their ids; each job reports its own completion notice and keeps the node's `status` in step (`queued`, `running`, then cleared or `failed`). A node whose existing status is `queued` or `running` is refused with `already_running`; orphaned statuses without a recoverable record become `failed` with `interrupted by a restart`. `storyboard_voice` creates one audio node per spoken line and reuses nodes by line id. Each call runs as a `media` job, so it can be cancelled and reported like other background work. Reference images an `@name` mention implies are added to the call and connected as `ref` edges; the project's resolution is mapped to the tier the gateway's catalog offers. When no catalog is published, the two configured video models are chosen by whether a call has reference images. A keyframe-driven segment sends only its first and last frames, never reference images.

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
| `videoRefModel` | `minimax-h3-ref2va` | Video model for a segment that has reference images but no first frame. |
| `maxSegmentSeconds` | `15` | Longest video segment one generation call may cover. |
| `minSegmentSeconds` | `4` | Shortest clip one storyboard-segment video call requests; shorter segments are generated at this length. |
| `generateConcurrency` | `8` | Media jobs one run may have in flight. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Media generation and local editing use separate execution paths and share media placement on the project canvas.

<details>
<summary>Implementation internals — click to expand</summary>

Music and video use asynchronous tasks. Speech follows the catalog's transport: `videos_task` preserves a remote task id for recovery, while `audio_speech` retains the legacy `/audio/speech` request. Music3 sends lyrics as the prompt and style as instructions. YuE2 records planning settings and returned ABC for subsequent composition; ACE-Step supports creation, reference cover, and range repaint. Breeze TTS 2 uses voice-design instructions and vocal events; reference cloning is refused because this transport does not expose it. TTS2 supports three modes: neither voice nor instructions selects the gateway default voice, instructions alone design a voice, and a voice reference is accepted only together with `ref_text`, the exact transcript of the reference audio; its language is detected from the text and must not be set. Resolved audio inputs record their source node, version, role, and path.

Speech and music return `{ path, model }` and add the file as an audio canvas node when possible; the gateway's media URLs expire, so the file is written before the tool returns.

Image and video return `{ status, model, path?, choices? }`. A parameter the user stated and the catalog accepts is used as is. A parameter with more than one accepted value that nobody stated (image: aspect ratio and resolution; video: ratio, resolution, and duration), or a stated value the catalog does not accept, produces `status: needs_choice` with the accepted options and a recommendation; nothing is generated, and the model asks the user through `ask_user_question` before calling again. Reference images fix the canvas, so image edits and frame-driven videos never ask for or send a ratio. Video sends the resolution tier word as the final `size`, so a tier at or below the generation stage skips an aggregate model's upscale stage.

When the [canvas](../canvas/README.md) service is present, image and video also accept canvas node ids: `generate_image` takes `referenceNodes`, and `generate_video` takes `firstFrameNode`, `lastFrameNode`, and `referenceNodes`. An image node stands for its file and a group for all of its image members in reading order; an unknown node, a node that is not an image or a group, or a group without images fails before any gateway request. A successful call adds a result node with derivation edges from its sources and returns `nodeId`. When the file was written but the node could not be added, the result keeps `path` and reports `canvasError`. Without the service the tools work on files only and reject node ids.

`ffmpeg` accepts local file paths or project-relative paths and writes one generated video, audio, or image file. `media_probe` reports container and stream metadata before editing. `merge_videos` probes its inputs, normalizes their video dimensions and frame rates, and supplies silent audio where a clip has no audio or a shorter track. A placed output links to explicit input node ids and canvas nodes whose paths match the input files. If the canvas is unavailable, the output file remains usable and the result reports the placement error.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Registers generation tools and the optional skill provider. |
| [`src/skills.ts`](src/skills.ts) | Enumerates the skill directories under `skillsRoot` and registers one provider for them. |
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
- [Studio pipeline](assets/studio-pipeline/SKILL.md), [craft](assets/studio-craft/SKILL.md), and [layout](assets/studio-layout/SKILL.md) — the production flow, storyboard craft, and canvas layout conventions.
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

- IndexTTS requires a reference audio source; Breeze uses voice-design instructions instead of preset voice names or reference cloning; TTS2 takes a bare request for the default voice, instructions for a designed voice, or a reference plus `ref_text` for cloning.
- Audio models must be offered by the key's catalog when discovery is enabled. Standalone tool defaults still come from deployment configuration; canvas nodes can select an offered model explicitly.
- Video and music run inside the tool budget, so very long renders need a larger `taskTimeoutMs` rather than a background job.
- Local editing requires usable FFmpeg and FFprobe executables. Non-ASCII `drawtext` requires a configured font file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
