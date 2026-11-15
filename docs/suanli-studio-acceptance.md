# Media studio self-test and acceptance plan

English | [中文](suanli-studio-acceptance.zh.md)

## Summary

This checklist is for developers and release testers of the [canvas studio](suanli-canvas-studio-spec.md). It separates repeatable self-tests, formal application acceptance, and remaining verification. Merging code does not complete the remaining checks.

The baseline has automated regression and Windows VM Native evidence using short local assets: import, candidate/adopted separation, local audio/video operations, four-track editing, full-quality cache, playback, download/export identity, partial rework, responsive layout and card summaries. It does not establish paid cloud generation, physical GPU performance, long-form reliability, or a fix for the intermittent Vpx decoder error.

## Contents

- [Developer self-tests](#self-tests)
- [Native acceptance procedure](#native)
- [Remaining verification](#remaining)
- [Cloud model acceptance](#cloud)
- [Completion and evidence](#completion)

<a id="self-tests"></a>

## Developer self-tests

Start from the repository root with the [development prerequisites](development.md). Run the smallest affected set; reuse valid results when source and inputs are unchanged. The commands below select existing owners, not a replacement for [testing policy](testing.md) or CI coverage.

| Change | Self-test | Required assertion |
|---|---|---|
| Timeline, versions, persistence | Canvas tests in the command below | Revision conflicts preserve drafts; saves are atomic; opaque version IDs survive; candidate creation never changes adoption; pinned media is retained. |
| Composition and media jobs | Tool-media and compositor tests | Frame/audio timing, subtitle composition, cache invalidation/reuse, cancellation, stale completion and restart recovery. |
| Local processing | Local FFmpeg tests | Actual duration, gain, fades and final-frame extraction; report a missing FFmpeg prerequisite as untested. |
| GUI, Remote and file transport | GUI tests and desktop forwarding tests | Draft/conflict recovery, scope isolation, Range 206/416, content length, cancellation, authorization and owner-only endpoints. |
| Agent-visible operations | Keyless recorded-session replay | Real shipped profile and tool registry; durable output matches; local rework preserves unrelated clips and documents. |
| Build and documentation | Build artifacts, then aggregate checks; documentation and lint checks | Published paths and Host/Client types pass; bilingual docs and generated references are current. |

```sh
pnpm exec vitest run packages/media/canvas/tests packages/media/tool-media/tests packages/util/timeline-compositor/tests
pnpm exec vitest run packages/media/tool-media/tests/local-edit.ffmpeg.spec.ts
pnpm exec vitest run packages/client/ui-sidebar-canvas/tests
pnpm exec vitest run apps/desktop/tests/web-document.spec.ts packages/experimental/liveshare/tests/endpoint-classification.spec.ts
pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t 'timeline-editing|canvas-media-adoption|canvas-local-edit|canvas-editor-context'
pnpm run build:artifacts
pnpm run build:check
pnpm run test:docs
pnpm run doc-sync
pnpm run lint
```

For keyless replay, set `DSH_SNAPSHOT=replay` in the invoking shell and remove live model credentials. Confirm the filter selects the intended scenarios; a skipped case is not a pass. Run the relevant Web replay owner after UI changes; [the Web lane](testing.md) owns full browser coverage. A focused green does not establish a green full Web suite.

Local jobs must not enqueue an Agent turn, model/context request, completion notice or session-log delivery. Keep the default wakeup policy in the test; disabling wakeups would hide the regression. Existing results do not exempt a changed job lifecycle from focused tests.

<a id="native"></a>

## Native acceptance procedure

Use the current official build, Electron Main/Host and shipped `dsh` profile. Use a disposable test project and existing local video/audio; record machine, OS, Electron/codec capabilities and artifact identity. A standalone prototype, hidden RPC write, edited project JSON or simulated DOM state cannot establish Native acceptance.

Before local-only tests, verify the effective text routes point to a request guard and session-log delivery is off, while the normal wakeup policy remains active. Record guard and Session counters. Capture project/timeline bytes, node/track/clip/version IDs, offsets, durations, adopted versions and frozen script/bible/storyboard files before starting.

| Step | UI action | Acceptance |
|---|---|---|
| 1. Import and audition | Import two videos and local music/voice; audition candidates and retry preview. | Candidate creation/audition does not adopt; Retry does not generate or import; local-only model and notice counters remain zero. |
| 2. Four-track edit | Use video, voice, music and subtitle tracks; set trim, volume, fades, subtitle style and a transition. | Save/reopen preserves the exact IDs, source offsets and values; undo/redo persists; candidate and adopted versions remain separate. |
| 3. Cache and export | Render full-quality cache, play naturally to the end, seek in both directions, export and download. | For the same revision/settings, preview, export and downloaded MP4 have identical hashes; independent probing confirms duration, dimensions, frame rate and audio. The local eight-second baseline is 720×1280, 24fps, H.264/AAC, 48kHz stereo. |
| 4. Partial rework | Change one clip through the editor; repeat an equivalent operation through the Agent replay. | Only affected cache parts regenerate; other clips, manual parameters, pins, music/subtitles and frozen documents remain unchanged; the displayed preview identifies the current revision. |
| 5. Responsive access | Check 390, 760/761, 1100/1101 and 1600px widths, short and tall windows, coarse pointer, wheel, real touch and keyboard. | All four tracks and primary actions are reachable; 44px clips and 28px track actions can be fully exposed; long parameters scroll both ways; focus stays visible; no page-wide horizontal scroll, overlap or clipping. |
| 6. Close and reload | Open the timeline, close it, reopen it and reload current data. | The trusted sidecar owns count/duration; the five-clip/eight-second baseline card shows 5/8.0s. Unread data shows the open-editor entry; legacy export metadata never supplies a false zero or stale summary. |

Restore temporary network interception and pointer overrides after testing. Use the formal Discard action for temporary drafts. Re-read durable files and counters after cleanup; unaffected files must be byte-identical. Keep one registered recording for each continuous run, with assertions and independent media/file checks.

<a id="remaining"></a>

## Remaining verification

Execute these before claiming the corresponding release capability. The short local baseline does not close them. Prioritize scope/data protection and unintended model calls, then recovery, real cloud routes and supported-device performance.

| ID | Remaining test and starting state | Pass condition | Evidence |
|---|---|---|---|
| N1 | Native long-lived loading at 390/761px; delay only the owned local read, then release it. | Loading remains readable; unsafe actions are disabled; scroll, focus, retry and recovery remain reachable; no cross-project write. Existing short reload observations do not establish the persistent spinner layout. | Recording plus actual loading/disabled transitions and cleanup proof. |
| N2 | Two projects/episodes with overlapping node IDs; open A, switch to B, delay/fail A's read, return and recover. | B never shows A's summary/draft/media; untrusted/unavailable data exposes no stale count; no stale save, late write or lost local draft. Current scope/untrusted assertions have component coverage, not Native switching evidence. | Native recording, scoped read/write trace and before/after files. |
| N3 | Reproduce the intermittent Vpx error with the original container/codec and candidate-switch path; test first play, Retry and restart. | Capture actual error and transport/codec facts; recovery neither regenerates nor changes adoption. Successful later playback alone cannot close the root-cause issue; persistent failure stays visible. | Error log, codec probe, Range/length headers, minimal reproduction and recovery recording. |
| N4 | Interrupt/cancel an active full-quality render, disconnect the renderer, restart Main/Host and receive a late completion. | No duplicate submission, stuck lease or partial ready MP4; cancellation settles owned work; late output cannot replace another revision; recovery is explicit and references remain intact. | Job/state trace, restart recording and output/cache hashes. |
| N5 | Real Windows/macOS devices with hardware acceleration on/off and H3 HEVC/H.264 assets. | Unsupported decoding enters the documented compatibility path; full output plays/seeks with sound; no silent codec failure or aspect/colour/orientation regression. | Device/driver/codec inventory, compatibility result and independent export probe. |
| N6 | Full Native projects at 60s, 5min and 15min; 1080 and 1440×2560 output, multiple video/audio/subtitle tracks. | Agree completion-time, peak RAM/disk and concurrency budgets before running; measure against them. Full-quality cached playback is smooth and synchronized; cancellation/restart and local rework preserve integrity. Real-time high-resolution composition is not required. | Duration/frame/audio checks, dropped frames, peak resources and render/rework timings. |
| N7 | Full read-only Web replay on its supported CI platform, including settings and document preview owners. | All required cases pass; independently classify locator ambiguity or platform baseline differences. Do not rewrite expectations solely to hide a failure; a focused pass is insufficient. | Complete command, selected count, failure disposition and CI artifacts. |

<a id="cloud"></a>

## Cloud model acceptance

These checks require an authorized paid-generation budget and the real MAAS catalog/permissions. Local testing authorization does not authorize cloud submission. Verify the actual gateway contract and model availability first; keep unsupported capabilities unavailable rather than claiming upstream model features are exposed by MAAS.

| Model/path | Test | Acceptance |
|---|---|---|
| H3 plus orchestration upscaling | Generate within H3's supported clip duration at native 768P, with dialogue and voice reference where available; use the aggregation route for higher resolution. | One intentional generation flow; query/reconnect without resubmission; probe actual delivery dimensions rather than trusting the model's 2K label; retain source/result versions and declared cost. |
| YuE2 | Generate and retain the returned score; change lyrics, style, melody/chords only where supported; compare versions through the panel and Agent. | Score and supported parameters survive restart and can be reused; a new candidate does not adopt itself; request/response fields match the live gateway. |
| ACE-Step | Text/instrumental generation, reference-audio adaptation, strength and interval repaint. | Reference and interval parameters are transmitted correctly; only the requested source region changes within an agreed audio tolerance; outside-region duration/content and pinned timeline versions remain protected. |
| MiniMax Music3 | Lyrics/style generation, audition and a second candidate. | Parameters, playable result, job recovery and explicit adoption work through the same panel/Agent operation layer. |
| Breeze 2 | Voice description, expression/emotion and speed controls exposed by the gateway. | Live audio reflects supported instructions; missing reference-cloning support is not presented as available; source text and parameters remain editable. |
| IndexTTS / MOSS | Supported reference-voice or described-voice narration path. | References and text are correct; audio is playable and versioned; unsupported voice-library, continuation, denoise and transcription entries remain absent. |
| Every enabled route | Timeout, cancellation, provider failure, client disconnect and application restart. | Query the same remote job rather than charging twice; show actionable errors; late results stay in the original project; no cross-project attachment or unintended adoption. |

Also test the creator journey: ask only missing duration, aspect, resolution and live-action/animation choices; offer a plan before generation, complete the authorized work, request review and redo only affected parts. Record actual requests, remote job IDs, measured output and charges without credentials or raw private logs.

<a id="completion"></a>

## Completion and evidence

For each item, record the build/ref, date, tester, machine, starting project/revision, command or actual UI action, observed result, independent file/media checks, recording and cleanup. Mark it passed, failed, blocked or untested; name the missing prerequisite. A mock result, skipped test, instantaneous loading state or successful retry cannot stand in for a different missing scenario.

Local readiness requires self-tests and the Native baseline, exact preservation of unaffected data, and zero unintended Agent/model activity. Advertising a cloud route requires its live acceptance; claiming device/long-form support requires N5/N6. Leave unresolved decoder causes and missing platform evidence explicit. Any corruption, scope leak, unintended paid submission, changed adopted version or preview/export mismatch fails acceptance.

## Dev Note

This is an execution checklist, not a runtime contract or a substitute for test source. Update results in the evidence record and revise this plan when supported capabilities change. Keep frozen creative documents and historical Session generations intact; follow the owning [snapshot rules](../snapshots/AGENTS.md) and [compatibility guide](cookbook/adding-a-session-format-version.md).
