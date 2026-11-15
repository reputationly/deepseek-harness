---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-15-wechat-message-source

[English](2026-11-15-wechat-message-source.md) | 中文

## 概述

为可合并扩展的消息来源新增 kind: wechat，覆盖持久化用户／开发者消息、收件箱插入及标题请求消息。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有来源分支、消息角色、内容和 Session 头均保持不变，新读取器继续接受原有分支。基线 packages/llm/llm/src/message.ts 明确要求 MessageSourceMap 可合并扩展，并要求消费者对未知 kind 使用默认处理。用户／开发者角色独立于来源标记；packages/llm/llm/src/index.ts 仅对 assistant 角色解释供应商回放信息，agent-loop 也只按精确 kind 特殊处理 runtime-context。因此旧读取器保留 wechat 这一不透明来源及原有角色／内容，不会将它解释成 model、tool 或 runtime-context。新增分支只有 kind，不包含凭据、路由地址或传输状态。实时微信投递由单独加载的集成负责，不会从陌生来源标记重建。这四个新增分支无需提高 Session 格式版本。

<a id="verification"></a>
## 验证

通过 git show origin/master 阅读基线消息来源契约及 LLM 投影，并审查 JSONL 解析器和 agent-loop 的判别字段处理。pnpm exec vitest run packages/llm/llm/tests/message.spec.ts packages/session/session-persistence-jsonl/tests/generation.spec.ts：81 项通过。画布、媒体和微信焦点回归复跑：108 项通过，Windows 跳过 1 项 POSIX 权限测试；该跳过不代表 POSIX 权限已经验证。

<a id="dev-note"></a>
## 开发备注

无。
