# 算力助手发布与更新

[English](README.md) | 中文

<a id="summary"></a>

## 摘要

使用这些脚本发布各平台安装包，保持更新入口一致，并配置客户端更新。

<a id="table-of-contents"></a>

## 目录

- [版本编号](#version-numbering)
- [发布](#publishing)
- [存储桶布局](#bucket-layout)
- [三类入口](#three-entry-points)
- [缓存头](#cache-headers)
- [发布后刷新入口](#after-publishing-refresh-pointers)
- [客户端发现更新](#client-update-discovery)
- [未签名安装包限制](#unsigned-package-limitations)
- [开发备注](#dev-note)

<a id="version-numbering"></a>

## 版本编号

```
<upstream DSH version>.ov.<UTC build minute>
0.2.2-rc.1.ov.202611081619
```

- 前缀沿用上游 `package.json`；上游版本变更时自动更新。
- 后缀是精确到分钟的 UTC 时间戳，同一上游版本下的连续构建因此递增。
- `electron-updater` 按 semver 比较版本。这个版本高于不带后缀的 `0.2.2-rc.1`，允许安装包更新替换该上游预发布版本。
- 同一分钟内的两次构建会得到相同版本号；连续发布之间须间隔一分钟。

使用 `node scripts/release/aurora-version.mjs` 生成版本号。CI 在 `prepare` 中只计算一次。

<a id="publishing"></a>

## 发布

手动触发 `.github/workflows/suanli-assistant-release.yml`，输入如下参数：

| 输入 | 含义 |
|---|---|
| `version` | 留空则自动生成 |
| `keep` | 每个平台保留的版本目录数，默认 2 |

流程为 `prepare → build(matrix) → publish`：先计算一个版本号，各平台打包并上传构建产物，全部成功后才在 `publish` 中上传安装包、更新入口并清理旧版本。

任一平台失败时，所有平台都不发布。若入口指向缺失的平台产物，客户端更新会返回 404。

`prepare` 先运行 `node scripts/release/plugin-freshness.mjs`。`apps/cli/package.json` 固定的外部插件在 `dist` 分支上有更新的发行包时，发布会停下；先合并插件升级 PR。

<a id="bucket-layout"></a>

## 存储桶布局

```
suanli-assistant/
  darwin-arm64/
    nightly-mac.yml                    # update pointer, rewritten on release
    latest.json                        # current version, size and sha256
    latest/suanli-assistant-*.dmg/.zip  # fixed filenames, replaced on release
    versions/<version>/...             # immutable rollback/differential files
  darwin-x64/                          # Intel Macs, same layout as darwin-arm64
  win32-x64/
    nightly.yml
    latest.json
    latest/suanli-assistant-win32-x64-unsigned.exe
    versions/<version>/...
```

- 新增版本目录时保留已有版本。重复发布同一个版本会覆盖它，发布前须检查版本号。
- 每个目标保留最近 `keep` 个目录；清理时排除当前正在发布的版本。
- 在 `latest/` 下保留一份固定文件名的副本并原位替换。不要再增加带版本号的重复副本：没有链接使用它，却会使存储、CDN 缓存和预取用量翻倍。

<a id="three-entry-points"></a>

### 三类入口

| 入口 | 使用方 | 缓存 |
|---|---|---|
| `versions/<version>/<file>` | `nightly.yml` 中的下载地址、差分更新 | 一年并带 `immutable` |
| `latest.json` | 下载页、客服与版本查询 | `no-cache`，秒级 |
| `latest/suanli-assistant-<platform>-unsigned.<ext>` | 用户打开的固定链接 | 五分钟 |

面向用户的固定下载链接使用第三种形式。若把 319 MB 的安装包放在长缓存的固定路径下，发布后部分用户仍会下载到旧内容，而且不同边缘节点的行为不一致。

<a id="cache-headers"></a>

### 缓存头

发布脚本会设置缓存头。若没有明确的 `Cache-Control`，R2 前的 CDN 可能按 `TTL = (当前时间 - Last-Modified) × 10%` 启发式计算；刚发布的安装包因此只有几秒新鲜期，早期下载会反复回源。所以每个对象都使用 `aurora-publish.mjs` 中 `CACHE_CONTROL` 指定的独立缓存头。

CDN 也需要匹配配置：

- `versions/` 和 `latest/` 下的安装包：遵循各自的 `Cache-Control`。
- `nightly.yml`、`nightly-mac.yml` 和 `latest.json`：不缓存或最多缓存 60 秒。长时间缓存这些入口会阻止客户端发现更新。
- 开启分片回源。关闭预刷新和智能压缩；安装包本身已经压缩。

上传通过 `curl --aws-sigv4` 使用 Cloudflare R2 的 S3 兼容接口，无需 AWS CLI。

<a id="after-publishing-refresh-pointers"></a>

## 发布后刷新入口

仓库配置下列 secrets 时，`publish` 末尾会刷新 EdgeOne；否则跳过该步骤：

| Secret | 含义 |
|---|---|
| `EO_SECRET_ID` / `EO_SECRET_KEY` | 只需 `teo:CreatePrefetchTask` 和 `teo:CreatePurgeTask` 权限的子账号凭据 |
| `EO_ZONE_ID` | 形如 `zone-…` 的站点 ID |

该步骤刷新 `nightly.yml`、`latest.json` 和 `latest/` 下的固定文件名，使入口和下载的安装包保持一致。

现有 EdgeOne 免费套餐限制见[套餐对比](https://cloud.tencent.com/document/product/1552/94165)：URL 预热额度为零，会返回 `LimitExceeded.BatchQuota`。因此该步骤不调用 `CreatePrefetchTask`。若套餐以后包含预热额度，可使用脚本已收集的 URL 列表加入预热。

每个边缘节点的首位用户仍需触发一次冷回源，后续用户命中缓存。

该步骤使用 `continue-on-error`：安装包已经上传，CDN 缓慢应在运行摘要中留下警告，而不是把已完成的上传标为失败。可在不调用 API 的情况下查看请求列表：

```
node scripts/release/eo-cache.mjs --index artifacts/win32-x64-latest.json --dry-run
```

<a id="client-update-discovery"></a>

## 客户端发现更新

安装包包含 `Contents/Resources/app-update.yml`，Windows 下为 `resources/app-update.yml`：

```yaml
provider: generic
url: https://aijisuan.kdns.fr/suanli-assistant/darwin-arm64
channel: nightly
```

构建从 `DSH_BRAND_UPDATE_BASE` 生成该文件。未设置时不生成文件，客户端也不检查更新。

<a id="unsigned-package-limitations"></a>

## 未签名安装包限制

macOS 使用系统 Squirrel.Mac 安装更新，并校验新安装包的代码签名。未签名安装包可以检测和下载更新，但系统会拒绝替换安装。

Windows NSIS 替换安装不执行该项校验。未签名安装包可以自动更新，但会出现 SmartScreen 提示。

macOS 要完成自动安装，必须配置 Developer ID 证书和公证。

<a id="dev-note"></a>

## 开发备注

无。
