---
kind: upgrade-guide
description: "Custom media profiles require local subprocess execution; Canvas recovery depends on retained task checkpoints and Host jobs."
---

# Canvas media tasks and recovery

English | [中文](guide.zh.md)

## Change

Canvas, project, bible, and production writes receive complete validation; rejected writes preserve bytes and revision. Bible aliases matching their own entry's name or aliases are deduplicated without case sensitivity; names shared across entries are rejected. Existing invalid files require explicit repair.

In Canvas Sessions, the four `generate_*` tools create nodes before submission and share `canvas_generate`'s Host jobs, validation, and durable attachment. Custom profiles need a jobs provider and controller. File-only compositions retain standalone generation. Visual generation requires a populated bible, including prompts without `@`. Success means a version is attached.

Task records are stored under `.canvas/<episode-file>.media/`. Opening the canvas reconciles completed files and resumes queries of known remote tasks without submitting them again. A submission the gateway answered with an HTTP error was not accepted: 5xx stays retryable, 4xx does not, neither sets `recoveryRequired`. Failures after the gateway accepts a submission and unknown submission outcomes require provider-history verification before another paid request. Local cancellation does not confirm cancellation at the provider. Downgrading while these records exist loses these protections.

Owner or Host shutdown preserves known remote tasks and retained files for recovery. Explicit cancellation stays terminal. Existing `cancelled` checkpoints also stay terminal because older records do not identify the cancellation source; verify provider history before manual resolution. Custom jobs providers must pass `kill` or `teardown` as the second `JobHooks.cancel` argument.

Canvas documents and media task records use shared atomic writes with bounded retries for Windows sharing errors. A retry that recovers a retained attempt waits for that attempt; it does not submit a replacement for the same node in that action.

`tool-media` requires a `subprocess` provider local to the Host. Unloading rejects new work, joins entire process trees, and waits for preview cache cleanup.

## Migration

1. Custom profiles need `@deepseek-ai/dsh-subprocess-local`; Canvas generation also needs `@deepseek-ai/dsh-jobs-local` and `@deepseek-ai/dsh-tool-jobs`. Desktop already includes these providers.
2. Populate the project bible before visual generation. Generation starts directly; there is no budget-confirmation step.
3. Back up `.canvas/` and `outputDir`; retain checkpoints until recovery completes. Remote queries require the original gateway configuration. Completed files need no provider submission. Verify provider history before resolving `recoveryRequired`; prompt changes do not clear it.
4. Open the canvas and confirm recovered results appear as active versions and nodes leave queued/running state. Resolve active tasks before downgrading. Videos that fail to decode or play only audio without video frames use local compatibility previews under `.canvas/previews/`. These caches can be rebuilt with FFmpeg; original media remains unchanged.
5. Configure gateway and credentials on the Host `tool-media` instance; Canvas UI uses its `media` Remote namespace. Desktop startup regenerates `cordis.patch.yml`, so edit the deployment's configuration source and restart. Verify both Agent and UI routes. Controlled tests must use credentials that cannot authorize production.
