---
name: dsh-fork-align-upstream
description: 上游发布新 dsh-v* tag 时（或每两周例行）把本 fork 对齐到 deepseek-ai/deepseek-harness：量漂移、合并、按规则解冲突、重新生成派生文件、验证、bump 版本并发版；也用于判断一处改动应该放进 fork 独有包还是改上游文件。
---

# 对齐上游（fork SOP）

本 fork 跟随上游 `deepseek-ai/deepseek-harness`。上游不维护长期发布分支：日常只在 `master` 上走 PR 栈，发布时开短命的 `release/dsh-x.y.z` 集成分支，人工打 `dsh-v<版本>` tag，再由人手动 dispatch `release-publish.yml` 发布到 npm。所以本 fork 的对齐单位是**上游 tag**，不是分支。

## 关键数字

- 合并成本 = 被改的**上游自有文件**数量 × 上游同期动过它的次数。fork 独有文件（新增包、脚本、资源）零成本。
- 当前基线见 `scripts/fork-drift.baseline.json`，用 `corepack pnpm exec tsx scripts/fork-drift.ts` 复测。
- 目标态：上游自有文件 ≤ 60（当前 350）。

## 何时执行

- 上游出了新的 `dsh-v*` tag（主触发）。
- 每两周例行一次，即使没有新 tag，避免攒成一次大合并。
- 准备新增 fork 定制时，先读本 skill 的「改动该放哪」。

## 步骤

0. 前置：rerere 与工具就绪，并记录对齐前的漂移。

```sh
git config rerere.enabled true          # 同冲突只解一次，后续自动复用
git config merge.conflictStyle zdiff3
git fetch upstream --tags --prune       # 必须带 --tags：发布脚本靠 tag 决定版本
corepack pnpm exec tsx scripts/fork-drift.ts --limit 20
git describe --tags --abbrev=0 upstream/master   # 本次要跟到的上游版本
```

1. 在 fork 主干上**合并**（用 merge，不用 rebase；rebate 每次都要从零重解，merge 才能让 rerere 复用解法）。

```sh
git switch master
git merge --no-ff upstream/master
```

2. 按优先级解冲突，顺序不可调换：

   a. **派生文件**（生成物）：一律取上游的一份，然后重新生成，绝不手工合。
   b. **fork 独有路径**（新增包、`scripts/release/aurora-*`、`suanli-*.yml`、`brand.json`）：取 fork 版本。
   c. **上游自有文件里的品牌/发版差异**：手工合，只保留接缝（一行 import + 一次调用），逻辑放 fork 包。
   d. **已下线特性的冲突**（画布、媒体、时间线）：整块取上游。

3. 重新生成派生文件。

```sh
corepack pnpm install                     # pnpm-lock.yaml 是生成物
corepack pnpm run gen-config-catalog
corepack pnpm run gen-cordis-api
corepack pnpm run gen-client-catalog
corepack pnpm run gen-tool-catalog
corepack pnpm run gen-dependency-catalog
corepack pnpm run gen-session-format-catalog
corepack pnpm run test:snapshot:refresh   # 会话夹具；无 key 时跳过并说明
```

4. 验证（顺序固定，前一步失败就停）。

```sh
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
```

5. 复测漂移并更新基线。数字应当**下降**；上升就说明这轮混进了本该放进 fork 包的改动。

```sh
corepack pnpm exec tsx scripts/fork-drift.ts --write-baseline
```

6. 出对应版本（对齐完成后再 bump，不要先 bump 再合）。

```sh
corepack pnpm run release:dsh rc.N        # 或 patch / minor / 显式 x.y.z：只写 manifest 与 lock
git commit && git push                    # 版本提交进主干
```

   本 fork **不发布 npm**：`dsh-v*` tag 与 `release-publish.yml` 是上游的 npm 发布线，不跑。版本只是 manifest 的事实源，供桌面构建读取。

   发布走手动 dispatch：桌面 `Package Desktop · macOS/Windows`（`source_ref` 填主干或已有 `desktop-v*`）→ `Publish Desktop · COS`（上传 COS、改自动更新指针、传官网安装包）；蒜狸自有线走 `Release 蒜狸小助手`（版本自动为 `<harness 版本>.ov.<UTC 分钟>`，上传 R2 并刷 EdgeOne）。生产发布会自动打 `desktop-v<版本>` tag。

   自有插件若需要分发，不必经过 npm：插件管理器接受 git 地址、http(s) URL、`file:`/`link:` spec，可把插件 tarball 放 R2 后用 URL 安装，或直接内置进产品。

## 改动该放哪

按这个顺序判断，越靠前越是零成本：

| 手段 | 合并成本 | 例子 |
|---|---|---|
| 组合/overlay 换插件行 | 0 | 不加载上游 `ui-brand-official`，改加载自己的品牌插件 |
| 新增 fork 独有包 | 0 | `api/gateway-status`、`experimental/wechat` |
| 构建期注入（`DSH_CLIENT_*`、`brand.json`、资源文件替换） | 0–低 | 产品名、图标、标题 |
| `cordis.yml` 的 `config` / `disabled` / overlay | 0 | 功能开关、部署参数 |
| 改上游文件（最后手段） | 高 | 桌面壳启动接线；必须登记进 `references/change-inventory.md` |

## 红线

- 不为"顺手格式化/重排/重命名"改上游文件——那种 hunk 每次对齐都会再冲突一遍，收益为零。
- 业务逻辑不写进上游文件；上游文件里只留接缝。
- 不 import 上游包的**内部类型面**（`.../types` 跨包内部导入）；用公开 Service 定义或自声明类型。这种耦合是上游重构时最先断的。
- 不通过删上游测试/夹具来消除品牌差异；正确做法是换组合，让上游的测试继续有效。
- 不用 `git rebase` 对齐，不用 `--force` 推主干。
- 派生文件永远不手工合并。

## 常见坑

- **必须用 `corepack pnpm`**：`package.json` 锁 `pnpm@11.28.5`，PATH 里的旧版 pnpm 会重建 `node_modules` 然后因为 overrides 不匹配失败。
- 上游 tag 不 fetch 就看不到，`release:verify` 会因为 tag 与版本不符而失败。
- 上游 `apps/desktop` 的发布脚本经常改；fork 的差异应当留在自己的脚本与 workflow 参数里，不要改上游脚本本体。
- 对齐后老用户数据要迁移：注意 `SESSION_FORMAT_VERSION`、`docs/session-format-status.md`、`corepack pnpm run migrate:sessions-to-v4`。

## 开发期隔离：绝不碰别人的 home 与 profile

fork 的桌面壳会改写 `profiles/desktop/cordis.patch.yml` 并在 `<home>/.credentials.yaml` 里存网关 key。一旦进程解析到别人的 home（尤其是用户自己的 `~/.dsh`），后果是：读到别人的会话、改写别人的插件行与模型网关、把产品 key 写进别人的凭据库。这类事故不可自愈，必须靠启动期硬闸拦住。

**规则**

1. 开发/验证启动一律带显式隔离 home，且必须在临时目录下。日常看界面用固定 home（已存网关 key，启动直达工作区）：
   ```sh
   ./scripts/suanli-dev.sh          # DSH_HOME=/tmp/suanli-dev-home
   ```
   一次性的隔离实验用临时 home：
   ```sh
   DSH_HOME=$(mktemp -d /tmp/suanli-XXXXXX) corepack pnpm run dev:desktop
   ```
   `apps/desktop/scripts/dev.ts` 已在没有 `DSH_HOME`、或它不在 `$TMPDIR`/`/tmp` 下时直接退出（`isIsolatedDevelopmentHome`）。不要绕过这条闸。

2. 不要用 `DSH_BRAND_HOME_DIR` 之类的**运行期环境变量**去改产品 home 名——它是构建期写死的，运行期设了不生效，只会让人误以为已经隔离。

3. 写入 profile patch 前，`writeGatewayProfile` 会拒绝两类目标（`profilePatchRefusal`）：
   - 目标不在本产品 home 内（`outside-home`）；
   - 已存在且首行不是 `# Written by the desktop shell`、又含真实插件行的 patch（`foreign-patch`）。
   允许覆盖时先写 `cordis.patch.yml.bak-<ISO 时间戳>`。不要为了“让它跑起来”而去掉这些检查。

4. 杀进程只按 PID 树，先打印再杀，并确认目标不含 `/Applications/DeepSeek Harness.app`；**禁止** `pkill -f <模式>`——它会连带杀掉用户正在用的 DSH。

5. 调试桌面壳时，`console.error` 可能已经被测试或壳自己 mock 掉；需要看启动轨迹就写到文件（临时诊断），不要指望控制台。

**home 的两种用途**：`/tmp/suanli-dev-home` 是长期复用的开发 home（含网关 key 与会话）；`mktemp -d` 出来的是一次性 home（用来验证首次启动、填 key 页等全新状态）。不要把两者混用，也不要把 `/tmp/suanli-dev-home` 指向用户自己的 `~/.suanli-assistant`。

**自检**

```sh
# 启动前确认将要用的 home
echo "DSH_HOME=$DSH_HOME"            # 必须是 /tmp 或 $TMPDIR 下
# 运行中确认 Host 真的在这个 home 里
ps eww -p $(pgrep -f dsh-desktop-host | head -1) | tr ' ' '\n' | grep ^DSH_HOME=
```
