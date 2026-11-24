---
kind: upgrade-guide
description: "The Desktop release no longer ships the native LibreOffice engine; the application downloads it into $DSH_HOME on first launch, so Office conversion needs a reachable npm registry once."
---

# Desktop downloads the LibreOffice engine on first launch

English | [中文](guide.zh.md)

## Change

Previously every Desktop release carried the native LibreOffice engine (`@deepseek-ai/libreoffice-kit-<platform>-<arch>`, about 60 MB compressed) inside the application, so Office conversion worked offline from the first launch.

The release now ships only the locked engine identity in `resources/office-engine.json`: the package name, its version, and the npm SHA-512 integrity recorded for that version. On startup the application downloads that exact tarball from the npm registries in order (`https://registry.npmjs.org/`, then `https://registry.npmmirror.com/`), verifies the locked integrity, and unpacks it under `$DSH_HOME/dsh-runtimes/office-kit`. The Host receives that directory as `DSH_OFFICE_ENGINE_DIR` and the Office provider resolves the engine from it.

Nothing else changes on the startup path: the download runs in the background, and a conversion requested before it finishes reports the provider's localized `unavailable` message and succeeds on a later attempt. A machine that cannot reach any registry keeps every other feature and loses only Office conversion (preview, PDF conversion, and recalculation). Development runs, `dsh web` from source, and the Python SDK sidecar are unaffected: they install the engine normally.

The installer shrinks accordingly: the macOS arm64 unsigned DMG measured 326 MB with the engine shipped inline and 265 MB with it provisioned, against 372 MB before the compression and locale work in the same release.

## Migration

1. To accept the new behavior, change nothing. Confirm: after one launch with network access, `$DSH_HOME/dsh-runtimes/office-kit/@deepseek-ai/libreoffice-kit-<platform>-<arch>/package.json` exists and a DOCX preview converts.
2. To pre-provision an air-gapped fleet, place that same package directory under `$DSH_HOME/dsh-runtimes/office-kit/` before the first launch; a package whose `package.json` declares the locked name and version is reused without a download, and any other content is replaced.
3. To keep the engine inside the application, package with the engine included again by keeping the package in the prepared runtime: `resources/office-engine.json` is written only after the engine package is removed, so a build that stops before `runtime:office-engine-sidecar` still ships the engine and needs no download.
