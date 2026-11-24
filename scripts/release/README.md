# Suanli Assistant releases and updates

English | [中文](README.zh.md)

<a id="summary"></a>

## Summary

Use these scripts to publish platform packages, keep update pointers consistent and configure client updates.

<a id="table-of-contents"></a>

## Table of Contents

- [Version numbering](#version-numbering)
- [Publishing](#publishing)
- [Bucket layout](#bucket-layout)
- [Three entry points](#three-entry-points)
- [Cache headers](#cache-headers)
- [After publishing: refresh pointers](#after-publishing-refresh-pointers)
- [Client update discovery](#client-update-discovery)
- [Unsigned-package limitations](#unsigned-package-limitations)
- [Dev Note](#dev-note)

<a id="version-numbering"></a>

## Version numbering

```
<upstream DSH version>.ov.<UTC build minute>
0.2.2-rc.1.ov.202611081619
```

- The prefix follows the upstream `package.json`; an upstream version change updates it automatically.
- The suffix is a UTC timestamp to the minute, so successive builds under one upstream version increase.
- `electron-updater` compares semver. This version sorts above the bare `0.2.2-rc.1`, allowing packaged releases to replace that upstream prerelease.
- Two builds in one minute receive the same version. Wait one minute between consecutive releases.

Generate it with `node scripts/release/aurora-version.mjs`. CI calculates it once in `prepare`.

<a id="publishing"></a>

## Publishing

Manually trigger `.github/workflows/suanli-assistant-release.yml` with these inputs:

| Input | Meaning |
|---|---|
| `version` | Leave empty to generate automatically |
| `keep` | Version directories retained per platform; default 2 |

The flow is `prepare → build(matrix) → publish`: calculate one version; package and upload an artifact per platform (`mac-arm64`, `mac-x64`, `win-x64`, all three building in parallel); then upload packages, update pointers and clean up in `publish` after every platform succeeds. Each platform's artifact is downloaded into its own directory because both macOS targets publish a feed named `nightly-mac.yml`.

If a platform fails, no platform is published. Advancing a pointer to a missing platform artifact would make client updates return 404.

<a id="bucket-layout"></a>

## Bucket layout

```
suanli-assistant/
  darwin-arm64/
    nightly-mac.yml                    # update pointer, rewritten on release
    latest.json                        # current version, size and sha256
    latest/suanli-assistant-*.dmg/.zip  # fixed filenames, replaced on release
    versions/<version>/...             # immutable rollback/differential files
  darwin-x64/
    nightly-mac.yml
    latest.json
    latest/suanli-assistant-*.dmg/.zip
    versions/<version>/...
  win32-x64/
    nightly.yml
    latest.json
    latest/suanli-assistant-win32-x64-unsigned.exe
    versions/<version>/...
```

- Add version directories without changing existing versions. Republishing the same version overwrites it, so check the version before publishing.
- Retain the latest `keep` directories per target and exclude the version currently being published from cleanup.
- Keep one fixed-name copy under `latest/`, replaced in place. Do not add a version-named duplicate: it doubles storage, CDN caching and prefetch usage without any link using it.

<a id="three-entry-points"></a>

### Three entry points

| Entry | Consumer | Cache |
|---|---|---|
| `versions/<version>/<file>` | Download URLs in `nightly.yml`, differential updates | One year + `immutable` |
| `latest.json` | Download page, support and version lookup | `no-cache`, seconds |
| `latest/suanli-assistant-<platform>-unsigned.<ext>` | Fixed links opened by users | Five minutes |

Use the third form for a fixed user-facing download link. Putting a 319 MB package at a fixed path with long caching leaves some users on old bytes after releases, with different behavior across edge nodes.

<a id="cache-headers"></a>

### Cache headers

The publishing script sets cache headers. Without explicit `Cache-Control`, a CDN in front of R2 can use the heuristic `TTL = (current time - Last-Modified) × 10%`; newly published packages then have only seconds of freshness and early downloads repeatedly reach the origin. Each object therefore receives its own header from `CACHE_CONTROL` in `aurora-publish.mjs`.

Configure the CDN consistently:

- Packages under `versions/` and `latest/`: follow their own `Cache-Control`.
- `nightly.yml`, `nightly-mac.yml` and `latest.json`: no caching or at most 60 seconds. Long caching of these pointers prevents clients from discovering updates.
- Enable range-based origin fetching. Disable pre-refresh and smart compression; packages are already compressed.

Uploads use Cloudflare R2's S3-compatible interface with `curl --aws-sigv4`; AWS CLI is not required.

<a id="after-publishing-refresh-pointers"></a>

## After publishing: refresh pointers

At the end of `publish`, EdgeOne is refreshed when the repository has these secrets. Otherwise the step is skipped:

| Secret | Meaning |
|---|---|
| `EO_SECRET_ID` / `EO_SECRET_KEY` | Subaccount credentials requiring only `teo:CreatePrefetchTask` and `teo:CreatePurgeTask` |
| `EO_ZONE_ID` | Zone ID such as `zone-…` |

The step purges `nightly.yml`, `latest.json` and fixed filenames under `latest/` so pointers and downloaded packages agree.

The existing EdgeOne free-plan limitation is described in the [plan comparison](https://cloud.tencent.com/document/product/1552/94165): URL prefetch has zero quota and returns `LimitExceeded.BatchQuota`. This step therefore does not call `CreatePrefetchTask`. If the plan later includes prefetch quota, add it using the URL list already collected by the script.

The first user at each edge node still makes a cold origin request; subsequent users hit cache.

The step uses `continue-on-error`: packages have already been uploaded, so a slow CDN should leave a warning in the run summary rather than mark the completed upload as failed. Inspect the request list without calling the API:

```
node scripts/release/eo-cache.mjs --index artifacts/installer-win-x64/win32-x64-latest.json --dry-run
```

<a id="client-update-discovery"></a>

## Client update discovery

The package contains `Contents/Resources/app-update.yml`, or `resources/app-update.yml` on Windows:

```yaml
provider: generic
url: https://aijisuan.kdns.fr/suanli-assistant/darwin-arm64
channel: nightly
```

The build generates it from `DSH_BRAND_UPDATE_BASE`. When unset, the file is absent and the client does not check for updates.

<a id="unsigned-package-limitations"></a>

## Unsigned-package limitations

macOS uses native Squirrel.Mac to install updates and validates the new package's code signature. An unsigned package can detect and download an update, but the system rejects replacement installation.

Windows NSIS replacement installation does not apply that check. Unsigned packages can update automatically, with a SmartScreen prompt.

Working macOS automatic installation requires a Developer ID certificate and notarization.

<a id="dev-note"></a>

## Dev Note

None.
