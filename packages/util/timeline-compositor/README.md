---
description: "Browser-safe timeline evaluation, frame composition, subtitles, and audio mixing."
kind: "package-library"
---

# dsh-util-timeline-compositor

English | [中文](README.zh.md)

<a id="summary"></a>

## Summary

Stateless composition functions shared by the editor's full-quality cache and export encoder. The library takes a validated timeline and caller-owned decoded media; it opens no files, calls no Remote endpoints, and registers no Cordis service. Canvas supplies the timeline types through a type-only dependency.

## Table of Contents

- [Composition](#composition)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="composition"></a>
## Composition

`timelineFramesAt` evaluates visible clips at a timestamp. `paintTimeline` draws those frames, image motion, transforms, transitions, and subtitles into the supplied drawing context. `timelineGain` and `mixTimelineAudio` apply track and clip gain plus fades in the same time coordinate system. A missing visible source frame throws `TimelineFrameError` instead of publishing incomplete output.

The codec adapter owns decoding, font loading, encoding, and resource cleanup. Cached preview and export play the same final MP4; this library introduces no alternate preview renderer.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Composition uses the drawing context and fonts provided by the caller; it does not install fonts or select a codec.
- The library does not promise real-time playback. The editor waits for the complete full-quality cache before playing it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep this owner free of Host services and filesystem imports so Client bundles can inline it.

</details>
