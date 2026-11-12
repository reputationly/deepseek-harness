---
kind: upgrade-guide
description: "`tool-media` 的配置键 `skillAssetRoot` 改名为 `skillsRoot`，含义变成「装着若干技能的目录」。"
---

# 工具媒体技能配置改为 `skillsRoot`

[English](guide.md) | 中文

## 变更

`tool-media` 不再读 `skillAssetRoot`。新键 `skillsRoot` 指向「装着若干技能子目录」的父目录，每个子目录里有一个 `SKILL.md`，其 frontmatter 的 `name` 与目录名一致。默认值是包自带的 `assets/` 目录。仍然设置 `skillAssetRoot` 的部署会在加载时报未知配置键，而不是悄悄只注册一个技能。

本版本内置四个技能：`media-editing`、`studio-pipeline`、`studio-craft`、`studio-layout`。写 profile 补丁、`cordis.yml` overlay 或桌面 profile 时固定了旧键的人会受影响。

## 迁移

1. 在每一处 profile 补丁和 `cordis.yml` overlay 里，把 `skillAssetRoot` 改名为 `skillsRoot`。
2. 值改为父目录：原来指向 `…/media-editing` 的，改成包含 `media-editing` 及其他技能目录的那个目录。
3. 保留自定义技能时，把它挪到该根目录下的独立子目录，并让 `SKILL.md` 的 `name` 与子目录名一致。
4. 重启宿主，确认每个技能都能解析：`dsh` 能列出四个技能名，且没有 `has no YAML frontmatter` 或 `names skill <x> but lives in <y>` 报错。
