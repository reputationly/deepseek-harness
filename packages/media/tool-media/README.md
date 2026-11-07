---
description: "Model-facing image, speech, music, and video generation tools over one OpenAI-compatible media gateway."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-media

English | [中文](README.zh.md)

## Summary

Registers four tools that produce media through the deployment's gateway: `generate_image` (text-to-image and image editing), `generate_speech`, `generate_music`, and `generate_video`. Every call resolves the API key from the credential store by reference, writes the produced file into `outputDir`, and returns only its path.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

```yaml
- id: tool-media
  name: '@deepseek-ai/dsh-tool-media'
  config:
    baseURL: https://gateway.example.com/v1
    apiKeyEnv: DSH_MAAS_API_KEY
    imageModel: qwen-image-pro
    speechModel: indextts-2.5
    musicModel: minimax-music3
    videoModel: minimax-h3-fl2va
    outputDir: media-output
```

Generated files land in `outputDir` resolved against the process working directory. Asynchronous music and video requests poll until they finish or `taskTimeoutMs` elapses.

<a id="understand-the-implementation"></a>
## Understand the implementation

`generate_image` and `generate_speech` are synchronous: the gateway returns the media inline or as an expiring URL that the tool downloads before returning. `generate_music` and `generate_video` submit a task and poll its status, because those models run for minutes. Music requests send the prompt as `instructions`, which the gateway requires to decide the arrangement.

Every tool returns `{ path, model }`; the gateway's media URLs expire, so the file is written before the tool returns.

<a id="model-experience"></a>
## Model Experience

The tools add four model-visible capabilities with no system-prompt change. A failed gateway call surfaces the gateway's own message, which names the missing or invalid parameter; a missing key reports the credential reference and how to store it.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Speech synthesis requires a reference voice source; the gateway rejects preset voice names, so the model must be given an audio URL or data URI.
- The model catalog is configuration rather than discovery; a deployment that adds models edits its config instead of following a gateway listing.
- Video and music run inside the tool budget, so very long renders need a larger `taskTimeoutMs` rather than a background job.
