---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-15-wechat-message-source

English | [中文](2026-11-15-wechat-message-source.zh.md)

## Summary

Adds kind: wechat to merge-extensible message attribution, including persisted user/developer messages, inbox splices and title-request messages.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-15-wechat-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "60d0923f9b368772acf78693d60a388752722fb09d6273f1d8411753f5a8ddc7"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "7f7a8247378f3bd50c68483e2219d40801db785fca67128718ead96a09ed247a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "3b5ad8bfe739132e5f5c938f13ac8eb6950b4f6f32a7360a2da5f7983a5f2c77"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "9ecc82d78c17ff509ea3a52425b8d1893f6e9c0b3ef0b9660c28662835d059b2"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing source variants, message roles, content and Session headers remain unchanged. New readers accept the previous variants. The baseline packages/llm/llm/src/message.ts explicitly defines MessageSourceMap as merge-extensible and requires consumers to fall through unknown kinds. Its user/developer roles are independent of the attribution kind; packages/llm/llm/src/index.ts only interprets provider replay metadata for assistant-role messages, and agent-loop only special-cases runtime-context by its exact kind. Older readers therefore retain wechat as opaque attribution while preserving role/content; they do not reinterpret it as model, tool or runtime-context. The new variant contains only kind, so no credentials, routing addresses or transport state enter these records. Live WeChat delivery is owned by the separately loaded integration, not reconstructed from an unfamiliar source tag. These four added alternatives need no Session format version increase.

<a id="verification"></a>
## Verification

Read the baseline message-source contract and LLM projection with git show origin/master, and reviewed the JSONL parser and agent-loop discriminant handling. pnpm exec vitest run packages/llm/llm/tests/message.spec.ts packages/session/session-persistence-jsonl/tests/generation.spec.ts: 81 passed. Focused canvas, media and WeChat regression rerun: 108 passed, 1 POSIX-permission case skipped on Windows; that skip does not establish POSIX permission behavior.

<a id="dev-note"></a>
## Dev Note

None.
