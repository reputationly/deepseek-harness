---
name: studio-pipeline
description: 制作短剧、漫剧或 MV 时的总流程：先读画布、设定集先行、改已有节点而不是重建、花钱和删除前必须确认。用户提到短剧、漫剧、MV、分镜、设定集、配音、粗剪时先读它。
---

# 创作画布的总流程

画布是用户和你共用的同一份数据。用户随时可能手动改过它，所以每次动手前先读。

## 每次开始

1. 读画布：`canvas_get` 拿到 `revision`、节点、边和当前分集；需要设定集或项目信息时带上 `include: ['project', 'bible']`。
2. 看项目是否已有 `project.json`。没有就先问题材和画幅，再 `studio_project_create`；已有时读 `format` 决定按哪个品类流程做（`drama` / `comic` / `mv`）。
3. 设定集先行：角色、场景、道具先写进 `studio_bible_update`，再生成任何参考图。分镜里引用不存在的条目会被拒绝。

## 动手时的规矩

- **先查后建**：建节点前先 `canvas_get`，已有同名或同用途的节点就改它，不要删了重建。用户的版本历史只在你改同一个节点时才保留。
- **一次调用一批操作**：`canvas_edit` 的 `operations` 按顺序执行，`ref` 可以在同一批里被后面的操作引用。每次带 `baseRevision`，被拒（`canvas: revision is ...`）时重新读一遍再改，不要盲重试。
- **分镜是源头**：视频从分镜的镜头来，不手写镜头。改镜头用 `update_shot` / `insert_shot` / `move_shot`，一次调用只产生一个版本。
- **花钱前确认**：`canvas_generate` 返回 `needs_confirmation` 时把预算（调用次数、视频秒数、配音句数）转述给用户，用户同意后再带 `confirmToken` 调用。令牌只对同一份计划有效。
- **删除前确认**：删节点、删设定条目、删镜头都要先说明删什么、会影响哪些下游节点，得到用户同意再动手。
- **阶段不倒退**：`studio_stage` 只在用户确认后 `advance`；要跳过闸门必须写 `override.reason`。

## 一集一个会话

一集用一个会话推进；换集用 `studio_episode_use`，不要在一个会话里同时改两集。新集用 `studio_episode_create`，它有自己的画布文件。

## 停下来问用户的时候

- 要花钱（生成图片、视频、配音、音乐）；
- 要删除或覆盖已有内容；
- 模型或参数不支持当前的输入组合（`needs_choice`）；
- 分镜里缺景别、时长，或引用不存在的设定条目（`blocked`）。
