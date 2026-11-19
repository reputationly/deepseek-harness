# fork 改动清单：保留 / 删除

量测口径：`corepack pnpm exec tsx scripts/fork-drift.ts`。分叉点 `dsh-v0.2.2-rc.1` 那轮合并（2026-11-04）。

- fork 独有文件：508 个，+80701 行 —— **对齐零成本**
- 改到上游自有文件：350 个，+8817 / −2669 —— **全部合并成本**
- 目标：上游自有文件压到 60 以内

## A. 保留

### A1 品牌数据与身份（fork 独有，零成本）

| 内容 | 说明 |
|---|---|
| `brand.json` | 唯一事实源：产品名、bundleId、homeDirName、urlScheme、packageName、网关 |
| `apps/desktop/scripts/desktop-brand.{mjs,d.mts}` | 读取 `brand.json` 并校验（`homeDirName`/`urlScheme`/`packageName` 不得等于上游值） |
| `apps/desktop/src/brand-gateway.ts` | 品牌网关配置解析 + 生成 profile patch |
| `apps/desktop/src/brand-identity.ts` | 品牌身份（窗口标题、provider 名） |
| `apps/desktop/src/gateway-probe.ts` | 启动时网关探测 |
| `apps/desktop/src/keep-awake.ts` | 保持唤醒（微信设置里的开关） |
| 三个对应 spec | `brand-gateway`、`brand-identity`、`keep-awake` |
| `apps/desktop/src/pet/*.ts`、`apps/desktop/src/preload-pet.ts`、`tests/pet-window-policy.spec.ts` | 桌面宠物浮窗（透明置顶窗，消费宠物插件的 `window.dshPet`），改编自 MichengAI/dsh-codex-desktop（Apache-2.0）。上游文件里只有三处接缝：`src/main.ts` 的 `installPetWindow(...)`、`src/preload-app.ts` 的 `dshPetHost`、`tsdown.config.ts` 预加载列表与 `scripts/electron-builder-config.mjs` 打包文件列表里的 `preload-pet` |
| 宠物插件 | `apps/cli/package.json` 依赖 `reputationly/dsh-codex-pet` 的发行包（`suanli` 分支 `npm pack` 的产物，存放在该仓库 `releases` 分支，URL 按提交号固定；内置宠物只有蒜狸）。不能写成 `github:` 依赖：插件带 `prepack` 构建脚本，npm 会先装它的开发依赖再构建，依赖解析会卡住。桌面打包会在独立目录重新安装，URL 依赖在那里是传递依赖，pnpm 11 默认拒绝（`blockExoticSubdeps`）；所以打包时由 `apps/desktop/scripts/stage-external-packages.ts` 按根锁文件的 integrity 校验后把发行包放进桌面包集合，改用本地文件解析，接缝在 `scripts/package-target.ts` 的 `pack()`；`official-bundles` 的 Web 模板与可选列表各加一行 |
| 资源 | `renderer/assets/key-step-*.png`、`resources/brand-mascot.png`、`welcome-brand.svg`、图标（mac/win/tray） |

### A2 品牌客户端 UI（目前改在上游包内部，40 文件）

| 包 | 文件数 | 内容 |
|---|---|---|
| `client/ui-brand-official` | 16 | 蒜狸标志、白底、去鲸鱼动画 |
| `client/ui-plugin-manager` | 8 | 隐藏 account 入口与插件安装提示 |
| `client/ui-theme` | 5 | 去掉标志底板、产品字体 |
| `client/ui-settings-account` | 5 | 隐藏 account 设置 |
| `client/ui-conversation` | 3 | 首页 slogan、侧栏标志、去 Preview 标签 |
| `client/ui-sidebar` | 1 | 侧栏底部网关状态 |
| `client/ui-settings-general` | 1 | 保持唤醒的类型面 |
| `client/ui-model-selection` | 1 | 蒜狸隐藏模型（构建变量控制） |

**这批是当前最大的可消除成本。** 上游 `ui-brand-official` 的入口只做三件事：往 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.frame` 三个槽注册组件，且被 `DSH_CLIENT_BUILD_PROFILE === 'official'` 门控；它在 `packages/bundle/web-app/cordis.patch.yml` 里只占一行 `id + name`。建议改为 fork 自己的 `client-ui-brand-suanli` 包 + 替换那一行组合，这 40 个文件降到 0。

### A3 桌面壳接线（上游文件，必须逐处合）

保留范围内 58（A1 里改上游的）+ 32（轻度）+ 7（重度）个 `apps/desktop` 文件。高风险的是：
`src/main.ts`(+97/−9)、`src/locale.ts`(+155/−96)、`package.json`(+18/−17)、`scripts/electron-builder-config.mjs`(+37/−5)、`tsdown.config.ts`(+18/−3)、`src/welcome-backend.ts`、`src/web-document.ts`、4 个 README。

**收敛方向**：`main.ts` 只留一行 import + 一次赋值；产品名走 `electron-builder` 的 `productName` 与构建期 `DSH_CLIENT_TITLE`；图标走资源文件替换。

### A4 桌面发版线

| 内容 | 归属 |
|---|---|
| `scripts/release/aurora-publish.mjs`、`aurora-version.mjs`、`eo-cache.mjs`（+ types/spec） | fork 独有：Cloudflare R2 上传 + EdgeOne 刷新 |
| `.github/workflows/suanli-assistant-release.yml`、`suanli-typecheck.yml` | fork 独有 |
| `scripts/ops/suanli-installer`（10 文件） | fork 独有：下载站运维（Caddy / systemd） |
| `desktop-upload-plan.ts`、`desktop-website-installer.ts`、`retain-desktop-ci.ts` 等 | 改上游脚本，均为 1–7 行，多为产品名/路径参数 |

上游已有 `macos-package`、`windows-package`、`macos-intel-package`、`desktop-publish`、`desktop-rollout`，打包与发布主体直接跟随上游，fork 只叠参数与自己的 R2 线。

### A5 独立功能包（fork 独有，零成本）

| 包 | 文件数 |
|---|---|
| `api/account-controller` | 17 |
| `api/gateway-status` | 11 |
| `client/ui-gateway-status` | 13 |
| `experimental/wechat` | 15 |
| `experimental/wechat-bundle` | 12 |
| `experimental/client-ui-wechat` | 17 |

纪律：只依赖上游公开服务接口，不 import 上游包的内部类型面。微信已剥掉对 `dsh-canvas` 的依赖。

### A6 品牌相关的上游最小改动

`packages/llm/llm-deepseek-api-key`：2 文件、5 行 —— 已存 key 通过网关校验即直接进工作区。保留。

## B. 删除

| 内容 | 规模 | 理由 |
|---|---|---|
| `packages/media/canvas` | 59 文件 | 画布 |
| `packages/media/tool-media` | 76 文件 | 图像/视频/音频生成工具 |
| `packages/util/timeline-compositor` | 7 文件 | 自动剪辑时间线 |
| `packages/client/ui-sidebar-canvas` | 97 文件 | 画布界面 |
| `packages/jobs/jobs-local` 的画布改动 | 15 文件 | 画布渲染任务，取上游 |
| `snapshots/session` 画布/媒体夹具 | 161 文件 | 取上游 |
| `snapshots/sdk` / `snapshots/web` | 28 文件 | 取上游 |
| `docs/suanli-canvas-studio-spec.md` 等规格文档 | 见 `docs/` 68 文件 | 特性下线即删 |
| `docs/upgrade-guide` 中 fork 自写条目 | 24 文件 | 取上游 |
| `apps/cli/tests/fixtures/canvas-editor-context.ts` | 1 文件 | 画布夹具 |

自动消失、无需处理：`credentials/deepseek-account-platform`、`document/office-to-pdf`、`experimental/ptc-runtime-python` —— 上游已经删了这几个包，fork 只是没跟着删。

## C. 待定（需拍板）

| 内容 | 现状 | 建议 |
|---|---|---|
| `apps/web/tests/home-whale.e2e.ts` | fork 删了 201 行（品牌去掉了鲸鱼动画） | 品牌 UI 改成独立包后，该测试可以恢复，不必再删 |
| `apps/desktop/tests/expected/welcome/*.expected.txt` | fork 删了 10 个 | 随品牌欢迎页改造重录，而不是删除 |
| `apps/cli/composition.md`、`apps/cli/package.json` | 加了画布与微信插件行 | 微信保留该行，画布那行随特性下线删除 |

## D. 对账

| 指标 | 对齐前 | 目标 |
|---|---|---|
| 上游自有文件 | 350 | ≤ 60 |
| 其中保留范围内 | ~124 | ≤ 60（A2 独立包化后降到 ~84） |
| fork 独有文件 | 508 | 约 400（画布/媒体/时间线那批消失） |
