# 蒜狸小助手与 dsh 隔离验证清单

本文是给有 macOS / Windows 真实环境的测试者使用的验证清单：确认蒜狸小助手（白标桌面应用）与同一台机器上的 DeepSeek Harness（桌面版 DeepSeek Harness.app 与 npm 安装的 `dsh` CLI，下文统称 dsh）互不依赖、互不修改对方的数据。

## 1. 隔离设计（判定依据）

| 资源 | dsh | 蒜狸小助手 |
|---|---|---|
| Harness 数据目录（配置、会话、凭据、插件、运行时） | `~/.dsh`，或 `DSH_HOME` | `~/.suanli-assistant`；打包版忽略继承的 `DSH_HOME` |
| 共享 agent 配置目录 | `~/.agents`，或 `DSH_AGENTS_HOME` | `~/.suanli-assistant/agents`；打包版忽略继承的 `DSH_AGENTS_HOME` |
| Electron 数据目录（单实例锁所在） | macOS `~/Library/Application Support/@deepseek-ai/dsh-desktop`；Windows `%APPDATA%\@deepseek-ai\dsh-desktop` | macOS `~/Library/Application Support/suanli-assistant`；Windows `%APPDATA%\suanli-assistant` |
| 应用包内 `package.json` 的 `name` | `@deepseek-ai/dsh-desktop` | `suanli-assistant` |
| 系统 URL scheme | `dsh://` | `suanli-assistant://` |
| Bundle ID / appId | `com.deepseek.dsh` | `com.ovaijisuan.jianli.office` |
| 终端命令 | 可安装 `/usr/local/bin/dsh` 或写入 Windows PATH | 不提供安装入口，不写 PATH |
| 更新源 | dsh 自己的源 | `<R2_PUBLIC_BASE>/suanli-assistant/<平台>/nightly-mac.yml` 或 `nightly.yml` |

这些值来自 [brand.json](../brand.json) 的 `homeDirName`、`urlScheme`、`packageName`，实现见 [brand-identity.ts](../apps/desktop/src/brand-identity.ts)。

## 2. 被测构建

- 必须使用 `whitelabel` 分支上包含提交 `brand: keep the desktop shell's state apart from an installed dsh` 及之后的构建。更早的构建没有隔离，会写入 `~/.dsh` 并在 DeepSeek Harness 运行时秒退。
- 推荐来源：GitHub Actions 手动工作流 **Release 蒜狸小助手** 的产物 `installer-mac-arm64`、`installer-win-x64`。
- 本地构建（macOS arm64）：在仓库根目录执行 `corepack enable && pnpm install --frozen-lockfile && pnpm run build:artifacts`，然后执行 `DSH_BRAND_UPDATE_BASE=<R2 公共地址> pnpm --dir apps/desktop run package:mac:arm64:unsigned`，产物在 `apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/`。仓库固定 pnpm 11，Homebrew 自带的 pnpm 9 无法完成打包。
- 本地构建不带 `--build-version` 时版本号是 `0.2.2-rc.1`，低于已发布的 `…ov.<时间戳>` 版本，更新检查会把旧版当作“新版本”；测更新功能请使用工作流构建。
- 确认包身份：`npx --yes @electron/asar@3.4.1 extract-file "<应用>.app/Contents/Resources/app.asar" package.json && grep -E '"name"|dshDesktopUpdateChannel' package.json && rm package.json`，期望 `"name": "suanli-assistant"`、`"dshDesktopUpdateChannel": "nightly"`。

## 3. 准备与注意事项

- 从终端启动 Electron 应用前，必须去掉 `ELECTRON_RUN_AS_NODE`。某些宿主（编辑器、agent 运行环境）会注入这个变量，应用会被当作纯 Node 启动，立即以退出码 0 结束。macOS 用 `env -u ELECTRON_RUN_AS_NODE …`，Windows PowerShell 用 `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`。
- 未签名构建首次打开会被系统拦截。macOS 执行 `xattr -dr com.apple.quarantine "<应用>.app"`；Windows 在 SmartScreen 中选择“仍要运行”。
- 欢迎页必须填入网关 API key 才能进入工作区。向项目负责人索取 key；不要提交、打印或截图 key 的明文。
- 测试蒜狸的步骤期间不要操作 DeepSeek Harness，否则 `~/.dsh` 的正常变化会混入比对结果。DeepSeek Harness 只需要保持运行。

### 3.1 macOS 基线快照

在每个用例开始前、结束后各执行一次，比对两次输出：

```sh
dsh_snapshot() {
  (cd ~/.dsh 2>/dev/null && find . -type f -not -path './sessions/*' -not -path './cache/*' -not -path './dsh-runtimes/*' -print0 | xargs -0 shasum -a 256 | sort -k2)
  ls -lR ~/.dsh/sessions 2>/dev/null | shasum -a 256
  ls -la ~/Library/Application\ Support/@deepseek-ai/dsh-desktop/desktop 2>/dev/null
}
brand_markers() {
  grep -rl "baked brand configuration" ~/.dsh/profiles 2>/dev/null
  grep -n "AURORA_API_KEY" ~/.dsh/.credentials.yaml 2>/dev/null | cut -d: -f1,2
}
dsh_snapshot > /tmp/before.txt; brand_markers
```

`brand_markers` 必须没有任何输出。它只打印行号和键名，不会打印密钥值。

### 3.2 Windows 基线快照（PowerShell）

```powershell
function Get-DshSnapshot {
  Get-ChildItem "$env:USERPROFILE\.dsh" -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\(sessions|cache|dsh-runtimes)\\' } |
    Get-FileHash -Algorithm SHA256 | Sort-Object Path | Format-Table -AutoSize Hash, Path | Out-String -Width 400
  (Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
  Get-ChildItem "$env:APPDATA\@deepseek-ai\dsh-desktop" -ErrorAction SilentlyContinue | Select-Object Name, LastWriteTime
}
function Get-BrandMarkers {
  Select-String -Path "$env:USERPROFILE\.dsh\profiles\*\cordis.patch.yml" -Pattern 'baked brand configuration' -ErrorAction SilentlyContinue | ForEach-Object Path
  Select-String -Path "$env:USERPROFILE\.dsh\.credentials.yaml" -Pattern 'AURORA_API_KEY' -ErrorAction SilentlyContinue | ForEach-Object LineNumber
}
Get-DshSnapshot > "$env:TEMP\before.txt"; Get-BrandMarkers
```

## 4. macOS 用例

| 编号 | 步骤 | 期望结果 |
|---|---|---|
| M1 同时运行不秒退 | 打开 DeepSeek Harness.app；再执行 `env -u ELECTRON_RUN_AS_NODE ELECTRON_ENABLE_LOGGING=1 "<路径>/蒜狸小助手.app/Contents/MacOS/蒜狸小助手" > /tmp/suanli.log 2>&1 &`；60 秒内不要点击任何窗口 | 60 秒后蒜狸进程仍在（`pgrep -fl "蒜狸小助手.app/Contents/MacOS"` 有输出），欢迎窗口标题为“蒜狸小助手”；DeepSeek Harness 窗口不会被唤到前台 |
| M2 数据目录 | M1 之后检查 `~/.suanli-assistant/profiles/desktop/cordis.patch.yml` 与 `~/Library/Application Support/suanli-assistant` | 两者都存在；`cordis.patch.yml` 第一行注释含 `baked brand configuration`；`dsh_snapshot` 与基线一致，`brand_markers` 无输出 |
| M3 填 key 并对话 | 在欢迎页填入网关 key，进入工作区发一条消息 | key 写入 `~/.suanli-assistant/.credentials.yaml` 的 `refs.AURORA_API_KEY`（用 `grep -c AURORA_API_KEY` 计数，不打印值）；会话出现在 `~/.suanli-assistant/sessions`；`~/.dsh` 与基线一致 |
| M4 忽略 `DSH_HOME` | 退出蒜狸；执行 `env -u ELECTRON_RUN_AS_NODE DSH_HOME="$HOME/.dsh" DSH_AGENTS_HOME="$HOME/.agents" "<路径>/蒜狸小助手.app/Contents/MacOS/蒜狸小助手"`，运行 30 秒后退出 | 仍然使用 `~/.suanli-assistant`；`~/.dsh` 与基线一致，`brand_markers` 无输出；`~/.agents` 无新增文件（`find ~/.agents -newer /tmp/before.txt` 无输出） |
| M5 安装顺序：先 dsh 后蒜狸 | 在只装了 DeepSeek Harness（已有 `~/.dsh` 数据）的机器上首次安装蒜狸并启动 | 蒜狸进入全新的欢迎页，不显示 dsh 的会话、工作区或 key；dsh 打开后数据、模型配置与安装前一致 |
| M6 安装顺序：先蒜狸后 dsh | 删除 `~/.dsh` 前先完整备份（或使用新 macOS 用户）；先装蒜狸并完成 M3，再装 DeepSeek Harness 并启动 | DeepSeek Harness 新建自己的 `~/.dsh`，看不到蒜狸的会话和 key；蒜狸再次打开时会话仍在 |
| M7 URL scheme | 两个应用都运行时执行 `open "suanli-assistant://open"`，再执行 `open "dsh://open"` | 前者把蒜狸窗口带到前台，后者把 DeepSeek Harness 带到前台 |
| M8 菜单 | 打开蒜狸的应用菜单 | 只有“关于”“检查更新…”等项，没有“管理 dsh 命令…”；`ls -la /usr/local/bin/dsh` 的结果与安装前一致 |
| M9 蒜狸自身单实例 | 蒜狸运行时再启动一次蒜狸 | 第二个进程退出，已有的蒜狸窗口被带到前台 |
| M10 更新检查 | 菜单中点“检查更新…”；同时 `grep -i "nightly-mac" /tmp/suanli.log` | 请求的地址是 `…/suanli-assistant/darwin-arm64/nightly-mac.yml`。服务器上已有该文件时显示最新或可更新；还没有时显示检查失败，但应用不能退出 |
| M11 删除蒜狸 | 退出蒜狸，把应用拖进废纸篓 | DeepSeek Harness 照常启动，`~/.dsh` 与基线一致；`~/.suanli-assistant` 保留（产品数据不随删除应用而删除） |

## 5. Windows 用例

| 编号 | 步骤 | 期望结果 |
|---|---|---|
| W1 同时运行不秒退 | 启动 DeepSeek Harness，再从开始菜单启动蒜狸，60 秒内不点击 | 蒜狸保持运行；任务管理器中两个应用各自有进程；DeepSeek Harness 窗口不会被激活 |
| W2 目录 | 检查 `%USERPROFILE%\.suanli-assistant\profiles\desktop\cordis.patch.yml` 与 `%APPDATA%\suanli-assistant` | 都存在；`Get-DshSnapshot` 与基线一致，`Get-BrandMarkers` 无输出 |
| W3 安装目录与卸载项 | 检查两个应用的安装目录，以及“设置 → 应用”中的条目 | 安装在不同目录；卸载列表中是两个独立条目 |
| W4 忽略 `DSH_HOME` | 在“系统属性 → 环境变量”为当前用户设置 `DSH_HOME=%USERPROFILE%\.dsh`，注销后重新登录，启动蒜狸并运行 30 秒 | 仍然使用 `%USERPROFILE%\.suanli-assistant`；`Get-DshSnapshot` 与基线一致。测试完删除该环境变量 |
| W5 URL scheme | 执行 `reg query HKCU\Software\Classes\suanli-assistant` 与 `reg query HKCU\Software\Classes\dsh` | 前者指向蒜狸的可执行文件；后者如果存在，仍指向 DeepSeek Harness |
| W6 PATH | 比较安装蒜狸前后的 `[Environment]::GetEnvironmentVariable('Path','User')` | 没有新增指向蒜狸目录的项；`where.exe dsh` 结果不变 |
| W7 卸载蒜狸 | 用默认选项卸载蒜狸 | `%APPDATA%\suanli-assistant` 和 `%LOCALAPPDATA%\suanli-assistant-updater` 被删除；`%APPDATA%\@deepseek-ai\dsh-desktop`、`%USERPROFILE%\.dsh` 和 DeepSeek Harness 自己的更新缓存保留；`%USERPROFILE%\.suanli-assistant` 保留；DeepSeek Harness 照常启动 |
| W8 安装顺序 | 按 M5、M6 的方法在 Windows 上各做一遍 | 与 M5、M6 相同 |
| W9 更新检查 | 点“检查更新…” | 请求 `…/suanli-assistant/win32-x64/nightly.yml`；文件不存在时只显示失败，应用不退出 |

## 6. 已知差异（不算隔离失败，结果照实记录）

- 电脑操作插件（Computer Use）的辅助程序固定使用 `com.deepseek.harness.computer-use`。如果两个应用都从插件市场装了它，macOS 的辅助功能、屏幕录制授权会共用。蒜狸默认不带这个插件。
- 两个应用通过插件市场安装插件时，都会用系统默认的 pnpm 全局缓存（macOS 为 `~/Library/pnpm/store`）。这是按内容寻址的下载缓存，不含配置或会话。
- 两个应用打开同一个项目目录时，都会读取其中的 `AGENTS.md`、`.env`、`.dsh/` 等项目文件。
- 欢迎页文案“配置 DeepSeek 官方模型，即可开始使用”沿用上游，与品牌无关。
- 服务器发布新版本之前，`nightly-mac.yml` / `nightly.yml` 可能还不存在，M10、W9 的失败提示属于预期结果。

## 7. 结果记录

逐条填写用例编号、平台与系统版本、被测构建版本号（`package.json` 的 `version`）、通过或失败、证据（命令输出、截图路径、`/tmp/suanli.log` 或 Windows 日志中的相关行）。失败项附上执行前后快照的 diff。不要粘贴任何 key 或凭据文件内容。
