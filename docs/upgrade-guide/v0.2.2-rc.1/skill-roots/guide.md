---
kind: upgrade-guide
description: "The `tool-media` config key `skillAssetRoot` becomes `skillsRoot` and now names a directory of skills."
---

# Tool-media skill configuration becomes `skillsRoot`

English | [中文](guide.zh.md)

## Change

`tool-media` no longer reads `skillAssetRoot`. The new key `skillsRoot` names the directory that holds one subdirectory per bundled skill, each with a `SKILL.md` whose frontmatter `name` matches its directory. The default is the package's own `assets/` directory. A deployment that still sets `skillAssetRoot` fails at load with an unknown config key instead of silently registering one skill.

This release ships four skills: `media-editing`, `studio-pipeline`, `studio-craft`, and `studio-layout`. Anyone writing a profile patch, a `cordis.yml` overlay, or a desktop profile that pins the old key is affected.

## Migration

1. In every profile patch and `cordis.yml` overlay, rename `skillAssetRoot` to `skillsRoot`.
2. Point it at the parent directory: a value that named `…/media-editing` becomes the directory that contains `media-editing` and the other skill directories.
3. If you keep custom skills, move each one into its own subdirectory of that root, with `name` in `SKILL.md` equal to the subdirectory name.
4. Restart the host, then confirm each skill resolves: `dsh` reports the four skill names, and none of them fail with `has no YAML frontmatter` or `names skill <x> but lives in <y>`.
