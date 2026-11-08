# 蒜狸小助手 发布与升级

面向维护者的一页说明：版本号怎么来、包装到哪、客户端怎么发现更新。

## 版本号

```
<上游 DSH 版本>.ov.<UTC 构建分钟>
0.2.2-rc.1.ov.202611081619
```

- 前缀跟随上游 `package.json`，上游发新版时自动变，不需要手改
- 后缀是 UTC 到分钟的时间戳，保证同一上游版本下的多次构建严格递增
- `electron-updater` 用 semver 比较，这个格式**高于**裸的 `0.2.2-rc.1`，所以正式版发布后客户端会自动升上去
- 同一分钟内构建两次会得到相同版本号；连发请间隔一分钟

生成方式：`node scripts/release/aurora-version.mjs`，CI 里由 `prepare` job 统一算一次。

## 发布

手动触发 `.github/workflows/suanli-assistant-release.yml`，两个输入：

| 输入 | 说明 |
|---|---|
| `version` | 留空则自动生成 |
| `keep` | 每个平台保留的版本目录数，默认 2 |

结构是 `prepare → build(matrix) → publish`：版本只算一次；每个平台只负责打包并上传 artifact；所有平台都成功后才由 `publish` 统一上传、翻指针、清理。

**某个平台失败时不会发布任何平台** —— 否则指针会翻到该平台不存在的版本，用户升级撞 404。

## 桶结构

```
suanli-assistant/
  darwin-arm64/
    latest-mac.yml                       ← 更新指针，每次发布重写
    latest/<当前版本>.dmg / .zip          ← 浮动下载路径，每次发布覆盖
    versions/<版本>/...                   ← 不可变，回滚和差量更新用
  win32-x64/
    latest.yml
    latest/<当前版本>.exe
    versions/<版本>/...
```

- 版本目录**只增不改**：同一版本重发会覆盖，所以发布前确认版本号
- 每个 target 保留最近 `keep` 个版本目录，删旧时跳过正在发布的那个
- `latest/` 只保留当前版本的安装包（文件名带版本，否则会无限累积）

上传走 Cloudflare R2 的 S3 兼容接口，用 `curl --aws-sigv4` 签名，不需要 AWS CLI。

## 客户端如何发现更新

安装包内 `Contents/Resources/app-update.yml`（Windows 为 `resources/app-update.yml`）：

```yaml
provider: generic
url: https://aijisuan.kdns.fr/suanli-assistant/darwin-arm64
channel: latest
```

由构建时的 `DSH_BRAND_UPDATE_BASE` 生成；未设置时不出这个文件，客户端也就不会检查更新。

## 未签名的限制

macOS 的更新安装走系统原生 Squirrel.Mac，它会校验新包的代码签名。未签名的包能**检测**到新版本、能**下载**，但**安装替换会被系统拒绝**。

Windows 的 NSIS 覆盖安装不做这个校验，未签名也能自动更新（用户会看到 SmartScreen 提示）。

要打通 macOS 的自动更新，需要 Developer ID 证书并完成公证。
