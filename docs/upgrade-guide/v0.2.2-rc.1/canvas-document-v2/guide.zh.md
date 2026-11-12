---
kind: upgrade-guide
description: "`canvas.json` 升级到格式版本 2：节点带版本、参考边带 role、文档带 revision。"
---

# 画布文件升级到格式版本 2

[English](guide.md) | 中文

## 变更

`<项目>/.canvas/canvas.json` 现在声明 `version: 2` 并带 `revision`。节点内容移到 `versions` 里，用 `activeVersion` 指向当前版本；边带 `role`（`prompt`、`ref`、`first_frame`、`last_frame`、`audio`、`source`），参考边还带 `order`。项目里还可以有 `.canvas/project.json`，为每一集指定画布文件。

读版本 1 的构建会在内存里迁移，下一次编辑时写回版本 2；比本版本更旧的构建会拒绝读取版本 2 的画布，并且不改动文件。直接读写该文件、固定其结构，或在同一项目上混用旧构建的人会受影响。

## 迁移

1. 把所有读写 `.canvas/canvas.json` 的节点升级到本版本；不要在较新构建编辑过的项目上再跑旧构建。
2. 从当前版本读内容：节点顶层不再有 `path`、`text`、`prompt`、`model`。用 `@deepseek-ai/dsh-canvas` 的 `activeVersionOf(node)` 取画布显示的那个版本。
3. 按 role 定位边：参考边 id 是 `<source>-><target>:<role>`，派生边仍是 `<source>-><target>`。
4. 写入时带基线版本：`canvas_edit` 必填 `baseRevision`；过期会被拒绝，报 `canvas: revision is <actual>, not the <expected> this edit was based on`。
5. 验证：打开项目后 `canvas_get` 报 `Revision <n> · episode e1`，文件以 `"version": 2` 开头。
