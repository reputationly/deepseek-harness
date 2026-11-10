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
    nightly-mac.yml                    ← 更新指针，每次发布重写
    latest.json                        ← 当前版本 / 大小 / sha256，下载页读这个
    latest/suanli-assistant-*.dmg/.zip ← 固定文件名，字节随版本浮动
    latest/<带版本号的文件名>           ← 旧链接兼容用，只保留当前版本
    versions/<版本>/...                ← 不可变，回滚和差量更新用
  win32-x64/
    nightly.yml
    latest.json
    latest/suanli-assistant-win32-x64-unsigned.exe
    versions/<版本>/...
```

- 版本目录**只增不改**：同一版本重发会覆盖，所以发布前确认版本号
- 每个 target 保留最近 `keep` 个版本目录，删旧时跳过正在发布的那个
- `latest/` 只保留当前版本的安装包：带版本号的那份每次发布换名，固定名那份原地覆盖

### 三个入口，用途不同

| 入口 | 谁用 | 缓存 |
|---|---|---|
| `versions/<版本>/<文件>` | `nightly.yml` 里的下载地址、差量更新 | 1 年 + `immutable` |
| `latest.json` | 下载页、客服、文档想知道"最新是哪个" | `no-cache`，秒级 |
| `latest/suanli-assistant-<平台>-unsigned.<ext>` | 给人手点的固定链接 | 5 分钟 |

**给用户的固定链接只能用第三种，不能把 319MB 的文件挂在一个长缓存的固定路径上**：那样发版后
一部分用户会永远拿到旧包，而且不同节点表现不同，几乎无法复现。

### 缓存头是发布脚本写的

R2 自己不发 `Cache-Control`，前面挂了 CDN（EdgeOne）时就会退回
`TTL = (当前时间 - Last-Modified) × 10%` 的启发式 —— 刚发出来的安装包只剩几秒寿命，每个早期下载
都会回源。所以每个对象上传时都带上自己的缓存头，值见
`aurora-publish.mjs` 的 `CACHE_CONTROL`。

CDN 侧要配合的规则（否则会反过来破坏自动更新）：

- `versions/` 与 `latest/` 下的安装包 → 长缓存（与其自身 `Cache-Control` 一致即可）
- **`nightly.yml`、`nightly-mac.yml`、`latest.json` → 不缓存或 ≤60 秒**。这几个是"指针"，
  一旦被长缓存，客户端会长期收不到新版本
- 开启「分片回源」，关闭「预刷新」和「智能压缩」（安装包本身已压缩）

上传走 Cloudflare R2 的 S3 兼容接口，用 `curl --aws-sigv4` 签名，不需要 AWS CLI。

## 发布之后：预热与刷新

`publish` job 末尾会让 EdgeOne 立刻认识新版本，只在仓库配了下列 secret 时执行（缺省则整步跳过）：

| secret | 说明 |
|---|---|
| `EO_SECRET_ID` / `EO_SECRET_KEY` | 子账号密钥，只需 `teo:CreatePrefetchTask`、`teo:CreatePurgeTask` |
| `EO_ZONE_ID` | 站点 ID，形如 `zone-…` |

它做两件事：

- **预热** `versions/<版本>/` 里的安装包 —— 节点主动回源，用户第一次点击就是命中缓存。不预热的话国内首拉只有几百 KB/s，319MB 要十几分钟。
- **刷新** `nightly.yml`、`latest.json` 和 `latest/` 里的固定文件名 —— 指针立刻翻转，不会出现"页面写着新版、下载到旧包"。

这一步是 `continue-on-error`：字节此时已经在桶里，CDN 慢一拍不该把一次成功的发布标成失败，但会在运行摘要里留下告警。想先看清单而不真调接口：

```
node scripts/release/eo-cache.mjs --index artifacts/win32-x64-latest.json --dry-run
```

预热按套餐计量，319MB 预热一次会占掉相应额度和回源流量；额度紧张时只预热安装包、不预热 `.blockmap` 也能省一半。

## 客户端如何发现更新

安装包内 `Contents/Resources/app-update.yml`（Windows 为 `resources/app-update.yml`）：

```yaml
provider: generic
url: https://aijisuan.kdns.fr/suanli-assistant/darwin-arm64
channel: nightly
```

由构建时的 `DSH_BRAND_UPDATE_BASE` 生成；未设置时不出这个文件，客户端也就不会检查更新。

## 未签名的限制

macOS 的更新安装走系统原生 Squirrel.Mac，它会校验新包的代码签名。未签名的包能**检测**到新版本、能**下载**，但**安装替换会被系统拒绝**。

Windows 的 NSIS 覆盖安装不做这个校验，未签名也能自动更新（用户会看到 SmartScreen 提示）。

要打通 macOS 的自动更新，需要 Developer ID 证书并完成公证。
