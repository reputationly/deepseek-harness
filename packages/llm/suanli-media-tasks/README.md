---
description: "Host Remote namespace that submits, polls, cancels, and downloads this deployment's generation tasks through the gateway's OpenAI-compatible task endpoints."
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-media-tasks

English | [中文](README.zh.md)

## Summary

Host Remote namespace that submits, polls, cancels, and downloads this deployment's generation tasks through the gateway's OpenAI-compatible task endpoints, keeping the gateway key on the Host.

## Table of Contents

- [Why this exists](#why-this-exists)
- [Transport rules](#transport-rules)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Why this exists

The platform's capability catalog names generation operations that the chat route cannot serve: images under `/v1/images/generations`, video and music under `/v1/videos`. This service is the one place that speaks those transports, so a caller submits a prompt, gets a task id, and polls it to a terminal state without handling the key or the polling cadence.

## Transport rules

- Submission answers either with a finished artifact (an image endpoint may answer synchronously) or with a task id; both are reported as one result.
- Status words normalize to `running`, `succeeded`, or `failed`; `SUCCESS`/`succeeded` and `FAILURE`/`failed` are the gateway's own vocabulary.
- A wait ends at the caller's deadline with `timed-out` and leaves the task running; only an explicit `cancel` asks the gateway to stop it.
- A caller cancellation stops the wait without a gateway call.
- The gateway may refuse a cancellation with `409` when the task is already past the point where it can stop; that surface is reported as `rejected` with the HTTP status rather than as a transport failure.
- `download` reads the artifact URL the task reported and writes exactly the path the caller names; `saveArtifact` does the same for a URL a caller already holds, which is how a synchronous image answer reaches disk.
- Image calls get their own budget (default 240 s): the image endpoint answers only when the image exists, while the task transports answer with an id and poll separately.

## Model Experience

None, as the service transports caller-supplied requests and artifacts and never enters a prompt, a tool schema, or a tool result by itself.

#### KV Cache effect

None: no model request is built or cached here.

## Known Limitations and Deferred Work

- Only image generation has a caller inside the product, the `generate_image` tool of `@deepseek-ai/dsh-suanli-media-tools`; video and music tasks are exercised by this package's tests and by direct Remote calls.
- Image calls are slow (about 36 s for a 2K image on this deployment), so a caller must budget for a blocking call rather than showing a spinner without a deadline.
- Image editing and reference-to-video need the platform to declare those capability entries first; until then their models are not in the catalog this deployment reads.
- Artifacts are downloaded to a caller-supplied absolute path; a caller inside the product must confine that path to the Session workspace.

<a id="dev-note"></a>
### Dev Note

The two transports answer creation differently on purpose: an image endpoint may return the artifact inline, while the task endpoints return an id. Submitting therefore reports one union instead of assuming a task, and callers poll only when `taskId` is non-empty. Polling lives on the Host because the credential does: a browser-driven poll loop would either leak the key or need its own proxy.
