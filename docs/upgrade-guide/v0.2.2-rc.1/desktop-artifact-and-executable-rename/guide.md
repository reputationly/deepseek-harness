---
kind: upgrade-guide
description: "Desktop installers, update objects, and the installed executable are renamed to the ASCII slug suanli-assistant."
---

# Desktop artifacts and the executable use `suanli-assistant`

English | [中文](guide.zh.md)

## Change

Packaged file names no longer carry the upstream product name. The download names, update-feed objects, and retained release files change from `deepseek-harness-<version>-<os>-<arch><suffix>.<ext>` to `suanli-assistant-<version>-<os>-<arch><suffix>.<ext>`; unsigned builds keep the `-unsigned` suffix.

The installed binary also changes name. The macOS bundle stays `蒜狸小助手.app` and the Windows install directory and display name stay the same, but the executable inside them becomes `Contents/MacOS/suanli-assistant` and `suanli-assistant.exe` instead of the display name. Both now come from `brand.json`'s `packageName` through `ARTIFACT_BASENAME` and `EXECUTABLE_NAME` in `apps/desktop/scripts/desktop-brand.mjs`, so a further rebrand renames them together.

Anyone who parses the download bucket, byte-pins installer URLs, launches the installed binary by path, or resolves shortcuts to the executable is affected. The stable website URLs (`dsh-latest-macos-arm64.dmg`, `dsh-latest-windows-x64.exe`) are unchanged.

## Migration

1. Replace `deepseek-harness-` with `suanli-assistant-` in scripts, configuration, mirrors, and documentation that name installers or update objects. Published objects under the old prefix stay valid, but this release does not create new ones.
2. Launch the installed executable as `suanli-assistant.exe` on Windows, or `蒜狸小助手.app/Contents/MacOS/suanli-assistant` on macOS. Update desktop shortcuts, scheduled tasks, and `PATH` entries that name the old file.
3. If your release automation calls the version suggester, keep passing an explicit `DSH_DESKTOP_BUILD_VERSION`. The listing matches only `suanli-assistant-` objects, so builds published under `deepseek-harness-` no longer reserve a version.
4. Re-run the packaged launcher `dsh --profile desktop --help` and confirm it prints help instead of failing to find an executable, then confirm the new installer file name in your own download directory.
