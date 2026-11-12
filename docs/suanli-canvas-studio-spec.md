# 蒜狸小助手 · 创作画布开发规格（MV / 短剧 / 漫剧）

- 版本：v3（2026-11-12），开发用。v1 的路线「搬流程、不装插件」用户已认可；v3 按对照现有代码的评审修正了数据模型、分集、Skill 注册、异步任务和预算，修正点集中在第 12 节。
- 读者：负责实现的开发 Agent。每期一个 PR，按第 9 节的顺序做，各期的自测要求和验收条件写在第 10 节。
- 仓库：`reputationly/deepseek-harness`，主干 `master`。分支命名 `devin/<unix秒>-<slug>`。
- 参考源码（只读）：`reputationly/ovaijisuandesign`、[NINKCH/dsh-infinite_canvas](https://github.com/NINKCH/dsh-infinite_canvas) 0.20.5（Apache-2.0）。

## 目录
0. 目标、范围、硬约束
1. 借鉴清单（ovaijisuandesign / dsh-infinite_canvas → 小助手落点）
2. 两条操作路径：对话驱动 与 手动精确设置
3. 数据模型（TypeScript 定义）
4. Host 侧模块与文件
5. Agent 工具规格
6. Skill 与预设
7. 界面：渲染与交互
8. 出片：时间线、预览、导出
9. 分期与每期文件清单
10. 自测要求与验收条件
11. 风险与待定项
12. 评审决定（v3）

---

## 0. 目标、范围、硬约束

### 0.1 目标
用户在小助手里完成一部 **短剧 / 漫剧 / MV**，从创意一直到 MP4，两种方式都能用、也能混着用：
- **对话驱动**：一句话让 Agent 建设定集、写剧本、拆分镜、建节点、连线、生图、生视频、配音、配乐、粗剪、导出；
- **手动精确设置**：在画布上逐个节点设定模型、比例、清晰度、时长、首尾帧、参考图顺序、台词、音色；在剪辑台里精确到帧调整入点、出点和音量。

两条路径改的是**同一份数据**，走**同一套校验**。

### 0.2 范围内
画布节点扩展（剧本、分镜表、时间线）、设定集、项目与分集、节点多版本、生成状态、按节点生成、切段规划、尾帧接首帧、预算确认、阶段闸门、逐句配音、音乐节拍、静帧运镜（漫剧）、剪辑台、ffmpeg 导出、Skill、媒体创作预设。

### 0.3 范围外（不要做）
- 语音识别和自动字幕（用户原话：「字幕这个先不做了」）。时间线的文字轨只支持手动输入的文字。
- 3D 导演台、手机虚拟机位、ComfyUI、网页视频下载、自动编剧室（无人值守连续创作）。
- 微信群聊。
- 复制 ovaijisuandesign 渲染层的反编译代码（`app/renderer/src/canvas-v3/*.js`、`export-engine/*.js` 是别家编译产物的镜像，**一行都不能拷**）。只能参考它的行为和接口设计，代码重新写。
- 直接安装或依赖 `@ninkch/dsh-infinite-canvas` 包。

### 0.4 硬约束（来自仓库 AGENTS.md 和用户决定）
1. 每期 PR 必须遵守 `AGENTS.md`：注册都走 `ctx.effect()`；可调参数写进 `Config`，不写死在代码里；跨边界的 id 用 `Branded`；不新增 `as unknown`；文案走 locale；源码中 `src/` 每个文件覆盖率 100%（`pnpm run test:coverage`）。
2. 持久化格式变更（`canvas.json`）：要写读入迁移，旧文件能读，新文件不会被旧版本误读；对外能感知的破坏性变更要写升级指南（skill `dsh-create-upgrade-guide`）。
3. 用户可见的变更要更新录制回放快照（`snapshots/session/...`）；GUI 变更要按 `dsh-client-ui-ux` 做真实渲染审查，PR 里附真实流程的 GIF（skill `record-browser-gif`）。
4. PR 描述按 `dsh-pr-description` 写，包含 Motivation、Changes、Testing、AI Usage 四节。
5. 媒体单文件发回微信时上限 20 MB（已有逻辑，导出时沿用）。
6. 从 dsh-infinite_canvas 移植的代码（切段算法）和技能文本，要在文件头注明出处和 Apache-2.0，并在包内 `NOTICE` 里登记。
7. 不打印、不提交 `AURORA_API_KEY`。

---

## 1. 借鉴清单

### 1.1 来自 ovaijisuandesign（参考行为和接口，代码重写）

| # | 能力 | ovaijisuandesign 位置 | 借什么 | 小助手落点 | 期 |
|:--|:--|:--|:--|:--|:--|
| O1 | 文档补丁模型 | `app/gateway/src/canvas-v3/protocol.ts`（`CanvasV3Document{schemaVersion,revision}`、`CanvasV3Change{before,after}`、`CanvasV3Patch`） | 文档带 `revision`，每次修改产出 `before/after` 变更，界面按变更增量刷新、做冲突检测 | `packages/media/canvas/src/document.ts` 加 `revision`；`canvas/change` 事件带上 revision | P1 |
| O2 | 上限常量 | 同上 `CANVAS_V3_LIMITS`（节点 1 万、边 2 万、提示词 2 万字、单次批量 64） | 上限做成 `Config` 字段并校验 | canvas 包新增的 `Config`（第 4.2 节，现在没有）：`maxNodes`、`maxEdges`、`maxPromptLength`、`maxBatchOperations` | P1 |
| O3 | 命令日志 / 撤销 | `canvas-v3/command-journal.ts` | 每次 `apply` 记录逆操作，支持撤销、重做 | `packages/media/canvas/src/journal.ts`，`.canvas/journal/<episode>.jsonl`，保留最近 `journalLimit` 条 | P3 |
| O4 | 资源多版本 | `project-kernel/composition.service.ts`（`res_`/`ver_` 前缀，内容哈希做 id） | 节点挂多个版本，重新生成不新建节点 | `CanvasNode.versions[]` + `activeVersion`（第 3.3 节） | P1 |
| O5 | 文本版本 | `text-version/*`（行级 diff） | 剧本、分镜改写也留版本 | `script` 和 `storyboard` 节点共用 `versions`，只保留最近 `textVersionLimit` 版，不做 diff 界面 | P1 |
| O6 | 主体库（角色一致性） | `protocol.ts` 的 `subject.*` 命令，`containerKind:"subject"` | 角色/场景/道具作为成员容器，成员挂参考图 | 设定集 `bible.json` 条目 + `imageNodes`（第 3.5 节） | P1 |
| O7 | 素材引用不拷贝 | `canvas-references/canvas-reference.ts`（`hilo-ref:` 前缀） | 提示词里引用素材，生成时再展开 | 提示词中的 `@角色名`，生成前展开成设定描述和参考图（第 4.6 节） | P2 |
| O8 | 模型能力目录 | `mcp-tools/src/tools/capability-tools.ts`、`capability-params.ts` | 按网关目录给出参数枚举和默认值；拿不到目录时返回空，不去乱调 | 已有 `tool-media/src/catalog.ts`，新增 Remote `media.capabilities` 供检查器面板使用 | P3 |
| O9 | 批量任务 | `task_query` / `task_wait` / `task_resolve`、`batch-helpers.ts`（`BATCH_CONCURRENCY`） | 批量提交、并发上限、按任务查状态 | `tool-media/src/node-runner.ts` 的队列，并发数写进 `Config.generateConcurrency` | P2 |
| O10 | 分阶段计划 | `mcp-tools/src/tools/plan-schema.ts`（计划内容和运行进度分开存） | 制作阶段的定义和运行状态分开 | `production.json`：`stages`（定义）+ `runtime`（进度） | P2 |
| O11 | 剪辑台 Agent 接口 | `editor-v3/capabilities.data.ts`、`host.ts`（`document.list/create`、`project.get/edit/view/history/snapshot/export`、`view: summary\|tracks\|clips\|full`） | 接口分层：读（分档视图）/ 改（批量操作）/ 快照（渲染单帧自查）/ 导出 | `timeline_*` 工具（第 5.4 节） | P4 |
| O12 | 剪辑结果回画布 | `protocol.ts` 的 `clip-studio.deliver` | 导出成片作为新节点，放在剪辑节点旁边，连派生边 | `timeline_export` 调用 `placeMediaArtifact` | P4 |
| O13 | 导出预设 | `renderer/src/canvas-v3/export-presets.js`（抖音、视频号、Shorts、YouTube 1080p/4K 等） | 只借预设清单 | `tool-media` Config `exportPresets`，默认 4 个（第 8.4 节） | P4 |
| O14 | 自动排版 | `renderer/src/canvas-v3/arrange.js` | 行为：按类型分列、不重叠 | 已有 `canvas/src/layout.ts`，扩展到新节点类型和分镜组 | P1 |
| O15 | ffmpeg 守卫和执行 | `gateway/src/edit/ffmpeg-args.ts`、`ffmpeg.service.ts` | 已在 PR #6 落地 | `tool-media/src/ffmpeg-*.ts`，导出直接复用 | — |
| O16 | 音视频分离节点 | `canvas-v3/video-audio-splits.ts` | 已在 PR #6 由 `ffmpeg` 工具覆盖 | — | — |
| O17 | 生成占位与状态 | `renderer/.../image-work-scheduler.js`、`generation.start` 命令 | 生成中、失败、重试状态直接显示在节点上 | `CanvasNode.status`（第 3.3 节） | P2 |

### 1.2 来自 dsh-infinite_canvas（Apache-2.0，可移植，注明出处）

| # | 能力 | 源文件 | 处理方式 | 小助手落点 | 期 |
|:--|:--|:--|:--|:--|:--|
| I1 | 节点端口语义 | `client.js` 第 74–86 行：image `prompt/ref → out`；video `prompt/frame/ref → out/tailpick/last`；`ref/char/scene/prop` 可多连 | 不做端口，改用带 `role` 和 `order` 的边表达 | `CanvasEdge.role/order`（第 3.2 节） | P1 |
| I2 | 分镜镜头字段 | `index.js` 第 2216–2240 行（上限 24 镜） | 字段对齐，去掉打斗专用字段，加上 `shotSize` | `Shot`（第 3.4 节） | P1 |
| I3 | 剧本分场 | `assets/canvas-craft/SKILL.md`（每场以【场N】开头） | 解析规则移植 | `storyboard.ts` 的 `parseScenes()` | P1 |
| I4 | 切段算法 | `shot-segments.js`（`planShotSegments`，seg 类型 opening/continuation/scene_change/new_character/closeup，join strict/loose/cut） | **逐函数移植成 TS**，保留算法和注释出处；预算和实际生成用同一个函数 | `canvas/src/segments.ts` | P2 |
| I5 | 制作阶段和闸门 | `production.js`（PRODUCTION_STAGES、G1 设定集先行、G2 分镜质量、G3 一表一视频、破坏性确认、越序；越过要记录） | 阶段裁剪为 9 个，闸门用 TS 重写 | `canvas/src/production.ts` | P2 |
| I6 | 预算后再付费 | `canvas_auto_budget` → `canvas_auto_generate` 两步 | 两步确认：先出预算单和确认令牌，再带令牌执行 | `canvas_generate` 的 `confirmToken`（第 5.3 节） | P2 |
| I7 | 媒体历史 8 次 | client 媒体历史 | 版本上限做成 Config，默认 8 | `Config.versionLimit` | P1 |
| I8 | 尾帧接力 | video 输出 `last`、`tailpick` | 生成后自动抽取尾帧，作为下一段首帧 | `node-runner.ts` 用 ffmpeg 抽尾帧（第 4.5 节） | P2 |
| I9 | 四层创作配置 | `assets/canvas-director/`（导演透镜、题材、规格、影调） | 技能文本移植，按需加载切片 | `assets/studio-director/`（第 6 节） | P5 |
| I10 | 先查后建、复用优先 | `cordis.patch.yml` media-studio persona | 写进 skill，并由代码兜底：同一张分镜表不重复建视频组 | `studio-pipeline` skill + 闸门 G3 | P2/P5 |
| I11 | 布局纪律 | `assets/canvas-layout/SKILL.md` | 文本移植 | `studio-layout` skill | P5 |
| I12 | 项目、分集、会话绑定 | README 项目结构（project.json、canvases/、bindings） | 结构重写 | `.canvas/project.json`（第 3.6 节） | P1 |
| I13 | 实时预览成片 | `client.js` MediaRecorder 录 WebM | **不借**，导出改用 ffmpeg；预览用浏览器多 `<video>` 同步播放 | 第 8.3 节 | — |

---

## 2. 两条操作路径

### 2.1 原则
- **一套操作，两个入口**：Agent 用 `canvas_edit`，界面用 Remote `canvas.apply`，最终都进入 `operations.ts` 的 `applyOperations(document, ops)`，用同一个校验器，报同样的错误。
- **一套生成，两个入口**：Agent 用 `canvas_generate`，界面点「生成」走 Remote `media.generateNodes`，最终都进入 `tool-media/src/node-runner.ts` 的 `runNodes(nodeIds, confirmToken)`。预算确认、并发上限、落版本、状态更新都在这里。
- **节点自己描述生成方式**：生成参数存在节点的 `gen` 里，输入关系存在边上（`role`/`order`）。Agent 的工作就是把这些写好，再调一次「按节点生成」，和用户手动在检查器里填完点「生成」是同一回事。因此用户可以随时接手 Agent 做到一半的画布，Agent 也能接着用户手动设好的节点继续。
- **Agent 能看到用户的改动**：用户手动改动不推送给模型，Agent 下一轮调 `canvas_get` 时就能读到。`canvas_get` 返回 `revision`，`canvas_edit` 和 Remote `canvas.apply` **必须**带 `baseRevision`（schema 必填），revision 不一致时整批被拒，调用方重新读一遍再改。这样两个会话写同一集、或 Agent 和用户同时改，都不会静默覆盖。

### 2.2 典型对照

| 用户想做 | 对话驱动 | 手动精确设置 |
|:--|:--|:--|
| 连参考图 | 「把林夏的三视图作为参考接到场 2 的视频」→ `canvas_edit connect role=ref` | 从图片节点右侧拖到视频节点；在检查器「参考图」列表里拖动排序 |
| 设首尾帧 | 「用场 1 尾帧做场 2 首帧」→ `connect role=first_frame` | 视频节点检查器的「首帧」「尾帧」槽：拖入图片，或从下拉框里选 |
| 改参数 | 「场 2 改成 9:16、10 秒」→ `canvas_edit set_gen` | 检查器里的下拉框和数字框，选项来自网关能力目录 |
| 生成 | 「生成场 2 的视频」→ `canvas_generate` | 节点上的「生成」按钮，或多选后「批量生成」 |
| 换版本 | 「用第 2 版」→ `set_version` | 节点底部的版本条，点缩略图 |
| 改分镜 | 「第 3 镜改成近景，时长 4 秒」→ `update_shot` | 分镜表格单元格直接编辑 |
| 剪辑 | 「把场 1 到场 6 粗剪，配上音乐」→ `timeline_assemble` | 剪辑台里拖动、裁剪、分割，调音量 |

---

## 3. 数据模型

所有类型放在 `packages/media/canvas/src/types.ts`，字段一律 `readonly`。id 用 `dsh-brand` 的 `Branded`（`JobId` 直接用 `@deepseek-ai/dsh-jobs` 导出的）：`CanvasNodeId`、`EpisodeId`、`BibleEntryId`、`ShotId`、`DialogueId`、`VersionId`、`TimelineClipId`。本文的 TypeScript 块是设计草图，标成 `ts ignore-check`，不单独编译；实现时以 `types.ts` 为准。

### 3.1 文档 v2

```ts ignore-check
export type CanvasNodeType =
  | 'image' | 'video' | 'audio' | 'text'      // 已有
  | 'script' | 'storyboard' | 'timeline'      // 新增
  | 'group'

export interface CanvasDocument {
  readonly version: 2
  readonly revision: number            // 每次成功 apply +1
  readonly nextId: number
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasEdge[]
}
```

迁移（`document.ts`）：`parseDocument(raw)` 遇到 `version: 1` 时转成 v2：`revision: 0`；节点上的 `path`、`prompt`、`model` 转成一个版本 `versions: [{id:'v1', path, prompt, model}]`，`activeVersion: 'v1'`；参考边按第 3.2 节的推断表补上 `role`，id 改写成 `${source}->${target}:${role}`，推断不出 role 的参考边保留原 id、不带 role：只显示，不参与生成，检查器里标「未指定用途」，让用户选一个 role。写回一律写 v2。遇到 `version > 2` 时报 `canvas/unsupported-version`，**不覆盖**该文件。

### 3.2 边

```ts ignore-check
export type CanvasEdgeKind = 'derivation' | 'reference'
export type CanvasEdgeRole =
  | 'prompt'        // 文本 / 剧本 / 分镜 → 生成节点：提供提示词
  | 'ref'           // 图片 → 图片/视频：参考图，按 order 排序后送给模型
  | 'first_frame'   // 图片 → 视频，最多 1 条
  | 'last_frame'    // 图片 → 视频，最多 1 条，必须同时有 first_frame
  | 'audio'         // 音频 → 视频/时间线
  | 'source'        // 视频/音频/图片 → 时间线：素材
export interface CanvasEdge {
  readonly id: string                  // 派生边 `${source}->${target}`；参考边 `${source}->${target}:${role}`
  readonly source: CanvasNodeId
  readonly target: CanvasNodeId
  readonly kind: CanvasEdgeKind
  readonly role?: CanvasEdgeRole       // 只在 kind === 'reference' 时出现
  readonly order?: number              // role === 'ref' | 'source' 时用，从 0 开始连续编号
}
```
校验规则放在 `operations.ts`，违反时这条操作跳过，并在 `skipped` 里写明原因：
- 同一对节点可以有多条边，但同一对节点、同一 role 只能有一条；派生边每对最多一条。所以同一张图可以同时是某个视频的 `ref` 和 `first_frame`。现有 `operations.ts` 的「已连接即拒绝」改成按上面的 id 判断；
- `disconnect` 新增可选 `role`：带 role 只删这一条，不带 role 删两节点之间的全部边；
- `first_frame`、`last_frame` 的 source 必须是 image，target 必须是 video；
- 一个节点上 `first_frame`、`last_frame` 各最多一条；
- `ref` 的数量不超过该模型目录里的 `maxReferenceImages`。这条校验在生成时做，不在连线时做，因为连线时不知道最终用哪个模型；
- 不能连成环（派生边和参考边一起算）；
- 未指定 role 时按两端节点类型推断：text/script/storyboard → 生成节点为 `prompt`；image → image/video 为 `ref`；audio → video/timeline 为 `audio`；video/image/audio → timeline 为 `source`。

### 3.3 节点

```ts ignore-check
export interface CanvasNodeBase {
  readonly id: CanvasNodeId
  readonly type: CanvasNodeType
  readonly title: string
  readonly x: number; readonly y: number; readonly width: number; readonly height: number
  readonly group?: CanvasNodeId
  readonly placed?: boolean
  readonly versions?: readonly NodeVersion[]     // 最近的在最后；超出 versionLimit 时丢掉最旧的非 active 版本
  readonly activeVersion?: VersionId
  readonly gen?: GenerationSpec                  // 只有可生成的节点有：image / video / audio
  readonly status?: NodeStatus
  readonly bible?: BibleEntryId                  // 这张图属于哪个设定条目（角色三视图等）
  readonly timeline?: TimelineRef                // 只有 timeline 节点有
  readonly tailOf?: { readonly node: CanvasNodeId; readonly version: VersionId } // 尾帧图片：来自哪个视频的哪个版本
  readonly stale?: boolean                       // 分镜改写后，这个视频节点对应的镜头组合已不存在（第 3.4 节），卡片显示「分镜已改」
  readonly inputChanged?: boolean                // 上游输入换了新版本（如上一段重新生成、尾帧换了），卡片显示「输入已更新」，重新生成后清除
}

export interface TimelineRef { readonly file: string; readonly durationMs: number; readonly exports: readonly ExportRecord[] } // file 相对 .canvas/
export interface ExportRecord { readonly node: CanvasNodeId; readonly preset: string; readonly timelineRevision: number; readonly at: string }

export interface NodeVersion {
  readonly id: VersionId                         // 'v1', 'v2'…，节点内单调递增
  readonly path?: string                         // 媒体文件绝对路径
  readonly text?: string                         // text / script 的正文
  readonly shots?: readonly Shot[]               // storyboard 的镜头
  readonly prompt?: string                       // 实际发给模型的完整提示词（已展开 @引用）
  readonly model?: string
  readonly params?: Readonly<Record<string, string | number | boolean>>
  readonly inputs?: readonly string[]            // 生成时实际用到的输入文件路径，按顺序
  readonly durationMs?: number                   // 音视频时长，生成后用 ffprobe 写入
  readonly width?: number; readonly height?: number
  readonly beats?: { readonly bpm: number; readonly beatsMs: readonly number[]; readonly sections: readonly { readonly fromMs: number; readonly toMs: number }[] } // audio_beats 写入
  readonly createdAt: string                     // ISO 时间
  readonly origin: 'agent' | 'user' | 'import'
}

export type GenerationKind = 'image' | 'video' | 'speech' | 'music'
export interface GenerationSpec {
  readonly kind: GenerationKind
  readonly prompt: string                        // 用户或 Agent 写的提示词，可含 @角色名
  readonly model?: string                        // 不填用 Config 默认
  readonly params: Readonly<Record<string, string | number | boolean>> // ratio, resolution, duration, audio, voice, lyrics…，取值以网关目录为准
  readonly shot?: { readonly storyboard: CanvasNodeId; readonly shots: readonly ShotId[] } // 这个视频节点对应分镜表里的哪几个镜头（按镜头 id，不按段序号）
  readonly dialogue?: { readonly storyboard: CanvasNodeId; readonly shot: ShotId; readonly line: DialogueId } // 这条配音对应哪句台词
  readonly tailChain?: boolean                   // 显式设 false 表示这一段不接上一段尾帧
}

export type NodeStatus =
  | { readonly state: 'queued'; readonly jobId: JobId; readonly at: string }
  | { readonly state: 'running'; readonly jobId: JobId; readonly at: string; readonly progress?: number }
  | { readonly state: 'failed'; readonly at: string; readonly error: string; readonly retryable: boolean } // 取消和重启中断时 retryable 为 true
```
- 节点的当前内容一律从 `versions` 里 `activeVersion` 对应的那个版本读，`path`、`text` 不再放在节点顶层。在 `document.ts` 里提供 `activeVersionOf(node)`，`resolveMedia` 改用它。
- 状态中「成功」就是没有 `status` 字段。宿主重启后，残留的 `queued`、`running` 一律改成 `failed`，`error: 'interrupted'`，`retryable: true`。
- `script` 节点：正文放在版本的 `text` 里。读的时候用 `parseScenes(text)` 解析出场次，不另外存。
- `timeline` 节点：时间线数据单独存成文件（第 8.1 节），节点上只放 `timeline: TimelineRef`。

### 3.4 分镜

```ts ignore-check
export type ShotSize = 'extreme_wide' | 'wide' | 'full' | 'medium' | 'medium_close' | 'close' | 'extreme_close' | 'insert'
export interface Shot {
  readonly id: ShotId                  // 's1'…，表内唯一，改顺序时不变
  readonly title: string               // ≤24 字
  readonly shotSize: ShotSize          // 景别，必填（闸门 G2）
  readonly visual: string              // 画面
  readonly motion: string              // 人物动作
  readonly camera: string              // 运镜
  readonly durationSec: number         // 1–15，具体上限由目录决定
  readonly characters: readonly BibleEntryId[]
  readonly scene?: BibleEntryId
  readonly props: readonly BibleEntryId[]
  readonly dialogue: readonly DialogueLine[] // 每镜 ≤6 句，每句 ≤200 字
  readonly sfx: string
  readonly negative: string
  readonly still?: StillMotion         // 漫剧：本镜用静帧加运镜，不生成视频
  readonly beat?: { readonly fromMs: number; readonly toMs: number } // MV：对齐到音乐上的时间段
}
export interface DialogueLine {
  readonly id: DialogueId              // 'd1'…，表内唯一，换版本时保留
  readonly speaker: { readonly kind: 'character'; readonly entry: BibleEntryId } | { readonly kind: 'narrator' } // 旁白/画外音用 narrator
  readonly line: string
}
export type StillMotion = { readonly type: 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'pan_up' | 'pan_down' | 'static'; readonly strength: number /* 0–1 */ }
export interface StoryboardSegment {   // 由 planShotSegments 算出，不手写
  readonly index: number
  readonly shots: readonly ShotId[]
  readonly durationSec: number
  readonly kind: 'opening' | 'continuation' | 'scene_change' | 'new_character' | 'closeup'
  readonly join: 'strict' | 'loose' | 'cut'
  readonly needsTailChain: boolean     // 是否用上一段尾帧做首帧
}
```
一张分镜表最多 `Config.maxShotsPerStoryboard`（默认 24）镜。切段结果不存，每次按镜头和目录算出来，保证预算和实际生成用的是同一份结果。

分镜改写后（`set_shots`、增删镜头、改时长）重新切段，按镜头 id 集合匹配已有视频节点：
- 某一段的镜头集合和某个视频节点的 `gen.shot.shots` 完全相同：复用这个节点，已有版本保留；
- 没有完全相同的：新建视频节点；
- 旧节点的镜头集合不再对应任何一段：标 `stale: true`，卡片显示「分镜已改」，不删除，由用户或 Agent 决定删掉还是保留；
- 闸门 G3 的判定条件因此是「同一张表、同一组镜头 id 只对应一个非 stale 的视频节点」。
- 这一步对账由 tool-media 的 `planNodes` 执行（`canvas_generate`、`storyboard_voice` 和 Remote `media.planNodes` 都会调到），幂等：画布没变时重复执行不产生任何改动。`set_shots` 本身是 canvas 的纯操作，只改分镜表，不建也不标视频节点。

### 3.5 设定集 `.canvas/bible.json`

```ts ignore-check
export interface Bible {
  readonly version: 1
  readonly revision: number
  readonly logline: string
  readonly style: { readonly visual: string; readonly palette?: string; readonly aspect: '16:9' | '9:16' | '1:1' | '4:3' | '3:4'; readonly director?: string; readonly genre?: string; readonly tone?: string }
  readonly entries: readonly BibleEntry[]
  readonly narrator?: { readonly model?: string; readonly voice?: string; readonly sampleNode?: CanvasNodeId } // 旁白音色
}
export interface BibleEntry {
  readonly id: BibleEntryId            // 'c1'（角色）'l1'（场景）'p1'（道具）
  readonly kind: 'character' | 'location' | 'prop'
  readonly name: string                // 提示词里写 @name 引用
  readonly aliases: readonly string[]
  readonly description: string         // 外观、服装，写成可以直接放进提示词的句子
  readonly imageNodes: readonly CanvasNodeId[]  // 参考图，第一张是主图
  readonly voice?: { readonly model?: string; readonly voice?: string; readonly sampleNode?: CanvasNodeId } // 角色音色
}
```
`name` 和 `aliases` 在整本设定集里不能重复。设定集项目级共享，各集共用。

### 3.6 项目与分集 `.canvas/project.json`

```ts ignore-check
export interface StudioProject {
  readonly version: 1
  readonly revision: number
  readonly format: 'drama' | 'comic' | 'mv' | 'free'
  readonly title: string
  readonly spec: { readonly aspect: Bible['style']['aspect']; readonly resolution: string; readonly fps: 24 | 25 | 30 }
  readonly episodes: readonly { readonly id: EpisodeId; readonly title: string; readonly file: string }[] // file 相对 .canvas/
  readonly bindings: Readonly<Record<string, EpisodeId>>  // 会话 id → 分集
}
```
- 没有 `project.json` 时行为不变：仍然只有一张 `.canvas/canvas.json`（按 `format: 'free'` 处理）。
- 调 `studio_project_create` 时创建 `project.json`。已有的 `canvas.json` 就作为第 1 集（`file: 'canvas.json'`），文件不移动，之后新增的集写成 `episodes/e2.json` 这样的文件。
- `CanvasService.directoryOf(session)` 不变，再加一个 `episodeOf(session)`：没有绑定的会话默认用第 1 集。所有 `canvas_*` 工具都只作用于当前会话绑定的那一集，`studio_episode_use` 用来切换绑定。
- 分集要贯穿存储、Remote 和事件，现在这些都只按目录：
  - `store.ts`：`canvasFile(directory)` 改成 `canvasFile(directory, episode?)`，按 `project.json` 里该集的 `file` 解析；串行锁从按文件改成按项目目录，`project.json`、`bible.json`、`production.json` 和各集文件共用一把锁；
  - Remote `canvas/get(sessionId)`、`canvas/apply(sessionId, operations)` 现在不传目录，目录由 session 推导，这一点不变；新增可选参数 `episode?: EpisodeId`，不带时用该会话绑定的那一集；
  - `CanvasChange` 增加 `episode?: EpisodeId`、`revision: number` 和 `files: ('canvas' | 'project' | 'bible' | 'production')[]`，界面只在变的是当前显示的那一集、或是项目级文件时重载。

### 3.7 制作进度 `.canvas/production.json`
```ts ignore-check
export type StageId = 'brief' | 'bible' | 'assets' | 'script' | 'storyboard' | 'generating' | 'post' | 'delivered'
export type GateId = 'G1_bible_first' | 'G2_storyboard_quality' | 'G3_one_video_per_shots' | 'G4_stage_order' | 'G5_destructive' | 'tail_chain'
export interface Production {
  readonly version: 1
  readonly episodes: Readonly<Record<string, { readonly stage: StageId; readonly overrides: readonly { readonly gate: GateId; readonly at: string; readonly reason: string }[] }>>
}
```

---

## 4. Host 侧模块与文件

### 4.1 包和依赖方向
```
packages/media/canvas      (@deepseek-ai/dsh-canvas)      数据、校验、操作、分镜、切段、阶段闸门、项目/设定集、canvas_* 与 studio_* 工具、Remote `canvas`
packages/media/tool-media  (@deepseek-ai/dsh-tool-media)  依赖 canvas（可选）。生成执行、按节点生成、配音、节拍、时间线导出、canvas_generate 与 timeline_* 工具、Remote `media`、Skill
packages/client/ui-sidebar-canvas                          画布界面、检查器、设定集/资产面板、剪辑台（懒加载）
apps/desktop/src/brand-gateway.ts                          只把 `skillAssetRoot` 换成 `skillsRoot`（与现有 `ffmpegPath`、`fontFile` 写法一致），并在补丁里启用媒体创作预设；其余新增 Config 走默认值（见第 4.7 节）
```
不新建包。剪辑台一律做成 `ui-sidebar-canvas` 包内的懒加载入口 `./client/timeline`。

工具归属：

| 工具 | 所属包 | 期 |
|:--|:--|:--|
| `canvas_get`、`canvas_edit`（扩展） | canvas | P1 |
| `studio_project_create`、`studio_episode_create`、`studio_episode_use`、`studio_bible_update`、`studio_expand_script` | canvas | P1 |
| `studio_stage` | canvas | P2 |
| `canvas_generate`、`storyboard_voice` | tool-media | P2 |
| `audio_beats`、`timeline_create`、`timeline_get`、`timeline_edit`、`timeline_snapshot`、`timeline_export` | tool-media | P4 |

Host 侧代码用 `ctx.jobs.start()` 注册任务、`ctx.jobs.kill()` 取消；模型侧等待和取消用 `dsh-tool-jobs` 现有的 `job_output`、`job_list`、`job_kill`，不另做工具。tool-media 按 `JobKindMap` 的声明合并方式登记两个新 kind：`media: 'media'`（按节点生成）和 `render: 'render'`（时间线导出），写法同 `jobs/src/view.ts` 里的 `bash`。

### 4.2 `packages/media/canvas/src/` 文件清单
| 文件 | 状态 | 内容 |
|:--|:--|:--|
| `package.json` | 改 | 新增 `@deepseek-ai/schemastery` 依赖（写法同 tool-media） |
| `config.ts` | 新 | canvas 包现在没有 Config。新增 `Config`：`maxNodes`、`maxEdges`、`maxPromptLength`、`maxBatchOperations`、`versionLimit`、`textVersionLimit`、`maxShotsPerStoryboard`、`journalLimit`，在 `index.ts` 导出并接到 `CanvasService` |
| `types.ts` | 改 | 第 3 节的全部类型 |
| `document.ts` | 改 | `parseDocument`（v1→v2 迁移）、`serialize`、`activeVersionOf`、上限校验 |
| `operations.ts` | 改 | 新增第 4.3 节的操作；`baseRevision` 冲突检测 |
| `layout.ts` | 改 | 新节点类型的默认尺寸；按「设定参考图 → 剧本 → 分镜 → 图片 → 视频 → 配音 → 成片」从左到右分列；一个场景的分镜和视频放在同一个组里 |
| `storyboard.ts` | 新 | `parseScenes(text)`、`validateShots(shots, bible)`、镜头增删改的纯函数 |
| `segments.ts` | 新 | 移植的 `planShotSegments(shots, {maxSegmentSec, minSegmentSec})`，文件头注明出处 |
| `production.ts` | 新 | 阶段、闸门 `checkGate(gate, ctx)`、越过记录 |
| `project.ts` | 新 | `project.json` 和 `bindings` 读写，`episodeOf(session)` |
| `bible.ts` | 新 | `bible.json` 读写，`expandMentions(prompt, bible)` 返回 `{prompt, imageNodes}` |
| `journal.ts` | 新（P3） | 撤销、重做 |
| `timeline.ts` | 新（P4） | 第 8.2 节的 `TimelineOp` 纯函数和诊断 |
| `store.ts` | 改 | 多文件原子写：沿用 tmp+rename；按项目目录一把串行锁；`canvasFile(directory, episode?)`（第 3.6 节） |
| `tools.ts` | 改 | `canvas_get`、`canvas_edit` 扩展；新增 `studio_*` 工具 |
| `index.ts` | 改 | Remote `get`/`apply` 新增可选参数 `episode`；新增 `project`、`bible`、`episodes`、`undo`、`redo`；`canvas/change` 带 `episode`、`revision`、`files` |

工具 schema 变化（`canvas_get` 加 `detail`/`include`，`canvas_edit` 加操作和必填 `baseRevision`）要在同一个 PR 里重录工具 schema 快照和受影响的会话快照。

### 4.3 `canvas_edit` 新增操作
```ts ignore-check
type CanvasEditOperation =
| { op: 'add'; ref?; type: CanvasContentType; title?; text?; path?; gen?: GenerationSpec; shots?: Shot[]; bible?: BibleEntryId; x?; y? }
| { op: 'set_gen'; node; gen: Partial<GenerationSpec> & { params?: Record<string, string|number|boolean|null> } } // 传 null 表示删除这个参数
| { op: 'set_text'; node; text }                 // script/text：新建一个文本版本
| { op: 'set_shots'; node; shots: Shot[] }       // storyboard：整表替换，新建版本
| { op: 'update_shot'; node; shot: ShotId; patch: Partial<Omit<Shot,'id'>> }
| { op: 'insert_shot'; node; after?: ShotId; shot: Omit<Shot,'id'> }
| { op: 'remove_shot'; node; shot: ShotId }
| { op: 'move_shot'; node; shot: ShotId; after?: ShotId }
| { op: 'set_version'; node; version: VersionId }
| { op: 'connect'; from; to; kind?; role?: CanvasEdgeRole; order?: number }
| { op: 'disconnect'; from; to; role?: CanvasEdgeRole }
| { op: 'reorder_refs'; node; sources: CanvasNodeId[] } // 按给定顺序重写 role=ref 的边的 order
```
- 每次调用最多 `maxBatchOperations` 条操作；整批只读写一次文件，只算一次 revision。
- 同一张分镜表的镜头改写都在一个新版本里完成：一次 `canvas_edit` 调用对一张表最多产生一个新版本。

### 4.4 `tool-media/src/` 新增文件
| 文件 | 内容 |
|:--|:--|
| `node-runner.ts` | `planNodes(nodes)` → `GenerationPlan`；`runNodes(nodeIds, token)`：执行前按当前画布重新 `planNodes`、重算令牌，和传入的不一致就不执行，返回新的预算单和令牌；一致时每个节点用 `ctx.jobs.start()` 注册一个 kind 为 `media` 的任务（带 `toolCall`）并发执行；按节点收集输入（第 4.5 节）；调用现有的 `generate_*` 实现函数；结果追加成新版本；更新 `status` |
| `budget.ts` | `GenerationPlan` → 预算单：每个节点的类型、调用次数、模型，视频总秒数、配音句数、图片张数、音乐次数；`confirmToken = sha256(canonicalJson(plan))` 取前 16 位 |
| `voice.ts` | `planDialogue(storyboard, bible)`：每句台词对应一个音频节点 `gen.kind='speech'`、`gen.dialogue`；音色取设定条目的 `voice` |
| `beats.ts` | `detectBeats(file)`：ffmpeg 解码成单声道 22050 Hz s16le PCM，计算能量通量，取峰值，估算 BPM 和节拍网格；返回 `{bpm, beatsMs[], sections[]}`（段落按能量变化切分） |
| `timeline-render.ts` | `buildRenderPlan(timeline, probes, preset)` → ffmpeg 参数（纯函数）；`renderTimeline()` 执行，复用 PR #6 的 runner |
| `timeline-assemble.ts` | `assemble(storyboards, nodes, options)` → `Timeline` |
| `node-tools.ts` | `canvas_generate`、`storyboard_voice`、`audio_beats` 工具 |
| `skills.ts` | 把 `index.ts` 里只认 `media-editing` 的 skill provider 改成枚举 `skillsRoot` 下的每个子目录（第 6.1 节） |
| `timeline-tools.ts` | `timeline_*` 工具 |
| `remote.ts` | Remote `media`：`capabilities()`、`planNodes(nodeIds)`、`generateNodes(nodeIds, confirmToken)`、`cancel(jobId)`（调 `ctx.jobs.kill()`）、`timelineRender(nodeId, preset)` |

### 4.5 按节点收集生成输入（`node-runner.ts`）
对节点 N：
1. 提示词：`N.gen.prompt`。如果 N 上有 `role=prompt` 的入边，按 `order` 把这些来源的当前文本拼在最前面。来源是分镜表时，只取 `gen.shot.shots` 里的镜头，按下面的模板展开：
   ```
   [景别] [画面]。动作：[动作]。运镜：[运镜]。台词（角色：台词）……。避免：[负向词]
   ```
   每镜一行，前面加时间码 `0–3s`。
2. 把 `@角色名` 展开：`expandMentions` 用设定描述替换 `@名字`，并把这个条目的 `imageNodes[0]` 加到参考图列表末尾（已经在列表里的不重复加）。
3. 参考图：`role=ref` 的入边按 `order` 排序后，取各来源当前版本的 `path`，再接上第 2 步补进来的参考图；数量超过目录允许的上限时，返回 `needs_choice` 让用户选，不自动截掉。
4. 首帧、尾帧：分别取 `role=first_frame` 和 `role=last_frame` 入边来源的当前版本。如果这一段 `needsTailChain` 为真、`gen.tailChain` 不是 false、而且没有手动设置首帧：
   - 上一段视频节点已有尾帧节点（`tailOf` 指向它的当前版本）：连 `role=first_frame` 边后生成；
   - 上一段还没生成：不生成这一段，返回 `blocked`，`gate: 'tail_chain'`，`missing` 写明上一段节点。解决办法是先生成上一段、手动设首帧，或把 `gen.tailChain` 设成 false。
5. 视频生成成功后：用 ffmpeg 抽出最后一帧（`-sseof -0.05 -frames:v 1`），存成 image 节点，标题「<节点标题> · 尾帧」，从视频连一条派生边过去，节点上写 `tailOf`。下一段视频节点已经存在、且没有手动首帧时，用 `role=first_frame` 连过去；下一段节点还不存在，或已手动设了首帧，就只建尾帧节点，等第 4 步在生成下一段时再连。重新生成上一段时，新版本另建尾帧节点，下一段的 `first_frame` 边改指新尾帧，并把下一段标 `inputChanged`。
6. 模型选择：`gen.model` 为空时，有首帧用 `videoModel`（fl2va），只有参考图用 `videoRefModel`（新增 Config，默认 `minimax-h3-ref2va`）。首尾帧和参考图同时存在、但模型不支持这种组合时，返回 `needs_choice`。`needs_choice` 的形状沿用 `tool-media/src/choices.ts` 的 `ParamChoice`，不另定义。
7. 生成结果追加为新版本，`activeVersion` 指向它，`origin` 是触发方（agent 或 user）；同时用 ffprobe 写入 `durationMs`、`width`、`height`。

### 4.6 并发、取消、失败
- 异步执行用 `dsh-jobs`：每个节点一个 job，job 的生命周期事件进 session log，满足「模型可见 ⟺ 可回放」；完成时由 `dsh-tool-jobs` 发会话内通知，Agent 不用轮询。节点上的 `status` 只是给界面看的镜像，`jobId` 就是 jobs 注册表的 id。
- 并发数为 `Config.generateConcurrency`（默认 3），超出的 job 在 runner 里排队；同一个节点同时只能有一个任务，重复提交返回 `already_running`。
- 取消（`job_kill` 或 Remote `media.cancel`）中止轮询，节点状态改成 `failed`，`error: 'cancelled'`，`retryable: true`。网关那边已提交的任务是否计费不归我们管，但界面要提示「已提交的任务可能仍会扣费」。
- 失败时保留之前的所有版本，`status` 写入 `failed` 和错误原因；`retryable` 根据网关错误码判断，5xx 和超时为 true，4xx 参数错误为 false。

---

### 4.7 新增 Config 总表

| 包 | 字段 | 默认值 | 谁写入 |
|:--|:--|:--|:--|
| canvas | `maxNodes` / `maxEdges` | 10000 / 20000 | 默认 |
| canvas | `maxPromptLength` / `maxBatchOperations` | 20000 / 64 | 默认 |
| canvas | `versionLimit` / `textVersionLimit` | 8 / 20 | 默认 |
| canvas | `maxShotsPerStoryboard` / `journalLimit` | 24 / 200 | 默认 |
| tool-media | `skillsRoot`（替换 `skillAssetRoot`） | `../assets/` | 桌面 `brand-gateway.ts` 写成 `resources/runtime/skills` |
| tool-media | `generateConcurrency` | 3 | 默认 |
| tool-media | `videoRefModel` | `minimax-h3-ref2va` | 默认 |
| tool-media | `confirmVideoCalls` / `confirmVideoSeconds` | 2 / 20 | 默认 |
| tool-media | `confirmSpeechLines` / `confirmImageCalls` / `confirmMusicCalls` | 20 / 8 / 2 | 默认 |
| tool-media | `exportPresets` | 第 8.4 节的 4 个 | 默认 |
| tool-media | `exportConfirmSec` | 300 | 默认 |

`brand-gateway.ts` 继续只写网关相关字段和 `ffmpegPath`、`fontFile`、`skillsRoot`。`inspectorMinWidth`（960 px）是界面断点，不随部署变化，作为常量放在 `ui-sidebar-canvas` 里，不进 Config。

## 5. Agent 工具规格

工具描述用英文写（和仓库现有工具一致），只写调用约定，不写创作方法（创作方法放 Skill）。按 skill `agent-experience` 的要求控制描述长度。

### 5.1 读
- `canvas_get({ nodes?: string[], detail?: 'summary' | 'full', include?: ('bible'|'project'|'production'|'segments')[] })`
  - 不论哪种 detail，返回值都带 `revision`、当前分集 `episode: { id, title }`，以及项目里是否已有 `project.json`、`bible.json`（`hasProject`、`hasBible`）。
  - `summary`（默认）：每个节点一行，包括 id、类型、标题、当前版本、状态、`gen` 摘要、入边（带 role）。
  - `full`：只对 `nodes` 里列出的节点返回完整 JSON（全部版本、`gen`、`status`、入边和出边）；不带 `nodes` 时报错，避免整张画布进上下文。
  - `segments`：给每张分镜表附上切段结果和预计调用次数。

### 5.2 改
- `canvas_edit({ operations, baseRevision })`：见第 4.3 节。返回 `{ revision, refs, skipped[] }`。
- `studio_project_create({ format, title, spec })`、`studio_episode_create({ title })`、`studio_episode_use({ episode })`
- 写项目级文件的工具都在项目目录锁内读-改-写，返回新的 `revision`：`studio_project_create` 在已有 `project.json` 时拒绝；`studio_episode_create`、`studio_episode_use` 只追加分集或改绑定，不需要 `baseRevision`；`studio_bible_update` 必须带设定集的 `baseRevision`；`studio_expand_script` 改的是画布，必须带画布的 `baseRevision`。
- `studio_bible_update({ logline?, style?, upsert?: BibleEntry[], remove?: BibleEntryId[], baseRevision })`：返回完整设定集。删除条目前，先检查分镜里是否还有引用；有引用时拒绝，并列出引用它的镜头。
- `studio_expand_script({ script: nodeId, scenes?: number[], baseRevision })`：从剧本解析出场次，每场建一个文本节点和一张空分镜表，加上 `prompt` 边，放进同一个组。已经铺开过的场次（有组记录了 `scene` 编号）跳过，不重复建。
- `studio_stage({ action: 'status' | 'advance', to?, override?: { gate, reason } })`

### 5.3 生成
- `canvas_generate({ nodes: string[], confirmToken?: string })`
  - 所有生成节点都走它（image、video、speech、music）。传入分镜表时，自动为每一段建或复用一个视频节点（闸门 G3：同一张表、同一组镜头 id 只对应一个非 stale 的视频节点），然后生成这些节点。
  - 返回值：
    - `{ status: 'needs_confirmation', plan: BudgetLine[], totals, confirmToken }`：整份计划满足任一条件时返回：视频调用次数 ≥ `Config.confirmVideoCalls`（默认 2）、视频总秒数 ≥ `confirmVideoSeconds`（默认 20）、配音句数 ≥ `confirmSpeechLines`（默认 20）、图片张数 ≥ `confirmImageCalls`（默认 8）、音乐次数 ≥ `confirmMusicCalls`（默认 2）。Agent 必须把预算转述给用户，用户同意后带上 `confirmToken` 再调一次。执行前按当前画布重算计划，令牌对不上（比如用户在确认期间改了画布）就不花钱，重新返回 `needs_confirmation`。
    - `{ status: 'needs_choice', choices: ParamChoice[] }`：与现有生图工具的约定相同。
    - `{ status: 'started', jobs: [{ node, jobId }] }`：立即返回，不等生成完成。完成后收到 jobs 通知，再调 `canvas_get` 看结果。
  - 闸门检查不通过时返回 `{ status: 'blocked', gate, missing: string[] }`。
- `storyboard_voice({ storyboard, shots?: ShotId[], confirmToken? })`：为每句台词建或复用一个音频节点（按 `DialogueLine.id` 复用），然后和 `canvas_generate` 走同一份计划和预算确认。旁白用设定集的 `narrator` 音色。
- `audio_beats({ node })`：返回节拍和段落，并写入 audio 节点当前版本的 `beats`。

### 5.4 剪辑（照 ovaijisuandesign editor-v3 的分层）
- `timeline_create({ title, from?: { storyboards?: string[], music?: string } })`：建 timeline 节点；有 `from` 时直接调用 `assemble`。
- `timeline_get({ node, view: 'summary' | 'tracks' | 'clips' | 'full', range?: { fromMs, toMs } })`
- `timeline_edit({ node, operations: TimelineOp[], baseRevision })`：操作见第 8.2 节。返回新 revision 和 `diagnostics`（空隙、重叠、素材丢失、超出素材时长）。
- `timeline_snapshot({ node, atMs: number[] })`：用 ffmpeg 渲染指定时间点的单帧（最多 6 张），落成临时图片返回给 Agent，用于自查，不放到画布上。
- `timeline_export({ node, preset, confirm?: boolean })`：导出。超过 `Config.exportConfirmSec`（默认 300 秒）时，需要带 `confirm: true` 再调一次。返回 `{ status: 'started', jobId }`，成片落到画布上（第 8.4 节）。

---

## 6. Skill 与预设

### 6.1 Skill 目录
放在 `packages/media/tool-media/assets/<name>/SKILL.md`，每个 skill 都有 frontmatter `name`、`description`；description 写清楚什么时候加载。

现在的注册只认一个 skill：`index.ts` 把 `skillAssetRoot` 当成 `media-editing` 这一个目录，名字和 locator 写死；桌面端 `main.ts` 指向 `resources/runtime/media-editing`，`scripts/primary-runtime/prepare.ts` 也只复制这一个目录。P1 要改成：
- Config 字段 `skillAssetRoot` 改名为 `skillsRoot`，含义变成「装着若干 `<name>/SKILL.md` 子目录的父目录」，默认 `../assets/`；改名是为了让旧配置启动时报错，而不是被悄悄当成父目录；
- provider 枚举子目录，每个子目录一个 skill，名字取 frontmatter 的 `name`，和目录名不一致时启动报错；
- `apps/desktop/src/main.ts`、`brand-gateway.ts` 改成写 `skillsRoot`，指向 `resources/runtime/skills`；`prepare.ts` 复制整个 `assets/`，同步改它的测试；
- 这是外部可配的 Config 字段改名，按 skill `dsh-create-upgrade-guide` 写升级指南。

| Skill | 内容要点 | 来源 |
|:--|:--|:--|
| `studio-pipeline` | 总流程：先 `canvas_get` 再动手；设定集先行；已有节点就改，不要删了重建；什么时候必须停下来问用户（花钱、删除、覆盖）；阶段推进；一集一个会话 | 改写自 canvas-studio，加上 cordis.patch.yml 里的 persona 规则 |
| `studio-craft` | 剧本格式（【场N】）、分场原则、分镜七要素（景别、画面、动作、运镜、时长、台词、音效）、图和视频提示词的写法、角色一致性（主图、三视图、@引用） | 改写自 canvas-craft |
| `studio-layout` | 布局约定：一类一列、组的命名、批量建节点后调用重排 | 移植 canvas-layout |
| `studio-director` | 导演透镜、题材、规格、影调。入口文件只放索引，每位导演或每种题材一个子文件，Agent 按需读取 | 移植 canvas-director 文本，保留署名 |
| `drama-production` | 短剧：每集 60–120 秒、3–6 场、开头 3 秒抓人、结尾留钩子；场次 → 分镜 → 参考图 → 逐段生成（尾帧接首帧）→ 逐句配音 → 粗剪 → 导出 | 新写 |
| `comic-production` | 漫剧：分格（每格一张图）、立绘一致性、每格选 `still` 运镜还是生成视频（贵）、对白时长决定每格停留多久 | 新写 |
| `mv-production` | MV：先有歌（上传或 `generate_music`）→ `audio_beats` → 按段落写分镜，`beat` 对齐 → 生成 → `timeline_assemble` 时卡在节拍点切镜 → 导出 | 新写 |
| `media-editing` | 已有（PR #6）。去掉里面的「字幕」字样，或者写明「不包含语音识别和字幕生成」 | 改 |

### 6.2 媒体创作预设
- 新增一个 `media-studio` 预设：系统提示前缀只写三句：「先读 studio-pipeline」「按项目 format 读对应的 production skill」「花钱和删除前必须确认」。预设不在 `brand-gateway.ts` 里（它只产出 profile 补丁）。按现有写法在 `packages/bundle/web-app/presets/` 下新增 `media-studio.patch.yml`，参照同目录的 `standard.patch.yml`，并加进该包 `package.json` 的 `dsh.bundle.patch` 列表；只在蒜狸桌面品牌启用（和 canvas 一样，在 `brand-gateway.ts` 的补丁里打开）。
- 用户在新建会话时选择这个模式；微信新建的会话仍用默认预设，但同样能用上这些工具和 skill。

---

## 7. 界面：渲染与交互

在 `packages/client/ui-sidebar-canvas` 上做，基于 xyflow。所有文案进 `locale/*.json`（中英必填，其余语言可先用英文）。开工前读 skill `dsh-client-ui-ux` 和 `dsh-responsive-ui`。

### 7.1 布局
```
┌ 顶栏：项目名 ▸ 分集下拉 ｜ 阶段条（立项…已交付，当前高亮） ｜ 撤销 重做 ｜ 设定集 资产 ｜ 全屏 ┐
│ 左：节点栏（文本 剧本 分镜 图片 视频 音频 成片）                                            │
│ 中：画布                                                                    右：检查器      │
└────────────────────────────────────────────────────────────────────────────────────┘
```
- 右侧栏最宽是 `min(窗口宽 − 280 − 400, 窗口宽 × 0.7)`（`ui-layout` 的 `AppFrame.tsx` 和 `columns.ts`），1280 宽的窗口最多 600 px。所以右栏里的画布是**预览和轻量操作**用的：检查器总是抽屉。
- 正式制作在**全屏工作室**里做：全屏层的画布区宽度 ≥ `inspectorMinWidth`（默认 960 px）时，检查器是固定在右边的侧栏，否则是抽屉。项目有 `project.json` 时，顶栏「全屏」按钮突出显示，Agent 建好项目后也提示用户进入全屏。
- 「全屏」把同一个画布实例放进全屏层，不复制状态，退出后视口位置保持不变。开发前先查 client 有没有现成的全屏或浮层扩展点；没有就用 portal 实现，并在 PR 里说明。

### 7.2 节点卡片（`nodes.tsx` 拆成 `nodes/<type>.tsx`）
| 类型 | 卡片内容 | 卡片上的操作 |
|:--|:--|:--|
| 图片 | 当前版本缩略图（容器比例 = 图片比例）、标题、设定条目标签（如「林夏·主图」） | 生成/重新生成、设为首帧（弹出视频节点选择）、下载 |
| 视频 | 首帧封面，悬停时静音预览；时长角标；`gen.shot` 存在时显示「场2·段1」 | 生成、播放、抽尾帧 |
| 音频 | 波形（用 Web Audio 解码后绘制，最多 400 根柱）、时长、台词原文（配音节点） | 播放、生成 |
| 剧本 | 场次列表（场号和标题），正文前 3 行 | 铺开到场景 |
| 分镜表 | 镜头小表：序号、景别、时长、画面摘要；底部显示「共 N 镜 · M 秒 · 切成 K 段 · 预计 K 次视频调用」 | 打开表格编辑、生成全部段、生成配音 |
| 成片 | 时间线缩略条（按片段颜色）、总时长、最近一次导出 | 打开剪辑台、导出 |
| 组 | 标题、成员数；场景组额外显示场号 | 折叠/展开、对组内批量生成 |

共同部分：
- **版本条**：有 2 个及以上版本时，在卡片底部显示，点击切换（调用 `set_version`）。
- **状态层**：排队中显示灰色遮罩加「排队中」；生成中显示进度环和已用时间；失败时显示红色边框和错误原因，带「重试」按钮（`retryable=false` 时不显示）。
- **边样式**：派生边为实线灰色；参考边按 role 区分颜色和标签（参考图 #1、首帧、尾帧、配音、素材），参考图的标签显示 order + 1。

### 7.3 检查器（手动精确设置的主要入口）
选中一个节点时显示：
- **生成区**（image/video/audio）：
  - 模型：下拉框，选项来自 Remote `media.capabilities(kind)`；不支持当前输入组合的模型置灰，悬停提示原因；
  - 参数：按所选模型的目录逐项生成控件（枚举用分段按钮或下拉框，数值用带范围的输入框，布尔用开关），默认值来自目录；
  - 提示词：多行输入框，支持输入 `@` 唤出设定条目补全；
  - 参考图：可拖动排序的缩略图列表，可删除、可从资产面板拖入；超过模型上限时，超出的部分标红；
  - 首帧/尾帧槽（video）：可拖入图片、选择节点、清空；
  - 台词和音色（speech）：音色下拉框，默认取角色设定；
  - 「生成」按钮：调用 `media.planNodes` 后，需要确认时先弹出预算对话框，再调用 `generateNodes`。
- **分镜表**：打开时用全宽表格编辑器（覆盖画布区域）。列：序号、景别、画面、动作、运镜、时长、角色（多选，来自设定集）、场景、台词（可增删行）、音效、负向词、静帧运镜。行可拖动排序；右侧实时显示切段结果，不同段用不同底色标出。
- **版本区**：列出全部版本（缩略图、模型、时间、来源 agent/user），可设为当前版本，可展开查看完整提示词和参数。
- 所有修改都调用 Remote `canvas.apply`，带 `baseRevision`。被拒时提示「画布已被更新」，自动重新读取，用户的输入保留在表单里。

### 7.4 设定集与资产面板
- 设定集：三个分栏，角色、场景、道具。每个条目可编辑名字、别名、描述、音色，可拖入参考图。「生成三视图」按钮会建一个图片节点，提示词由描述加三视图模板组成，`bible` 字段指向这个条目。
- 资产：按类型筛选（图片、视频、音频、成片），按设定条目筛选，按集筛选；可拖到画布上（复用现有节点，不复制文件）。

### 7.5 交互细节
- 从输出端拖线到目标节点时，按第 3.2 节的规则推断 role；可能有多种 role 时（例如图片连到视频），在落点弹出小菜单：参考图 / 首帧 / 尾帧。两节点之间已有某个 role 的边时，菜单里这一项显示为已选、不可再选；选别的 role 就再加一条边。
- 多选节点后右键菜单：批量生成、编组、对齐、自动排版、删除（删除需二次确认）。
- 快捷键：`Cmd/Ctrl+Z` 撤销、`Shift+Cmd/Ctrl+Z` 重做、`Delete` 删除（需确认）、`G` 编组、`Space` 播放当前选中的媒体。
- Agent 修改了画布时：收到 `canvas/change` 后增量刷新；新出现的节点闪烁 1.5 秒；视口不跳动，节点在视口外时左下角提示「新增 N 个节点」，点击定位过去。

---

## 8. 出片：时间线、预览、导出

### 8.1 时间线文件 `.canvas/timelines/<nodeId>.json`
```ts ignore-check
export interface Timeline {
  readonly version: 1
  readonly revision: number
  readonly spec: { readonly width: number; readonly height: number; readonly fps: 24 | 25 | 30 }
  readonly tracks: readonly Track[]          // 第 0 条视频轨在最底层
}
export interface Track { readonly id: string; readonly kind: 'video' | 'audio' | 'text'; readonly muted: boolean; readonly volume: number /* 0–2 */; readonly clips: readonly Clip[] }
export interface Clip {
  readonly id: TimelineClipId
  readonly startMs: number                  // 在时间线上的起点
  readonly durationMs: number
  readonly source?: { readonly node: CanvasNodeId; readonly version: VersionId; readonly inMs: number } // video/audio/图片素材
  readonly text?: { readonly content: string; readonly position: 'top' | 'center' | 'bottom'; readonly size: number } // 文字轨，手动输入
  readonly still?: StillMotion              // 图片素材的运镜（漫剧）
  readonly volume?: number
  readonly fadeInMs?: number; readonly fadeOutMs?: number
  readonly transitionIn?: { readonly type: 'cut' | 'dissolve' | 'fade_black'; readonly durationMs: number }
}
```
片段固定引用某个节点的某个版本。节点以后出了新版本，时间线不会自动跟着换，检查器里提示「素材有新版本」，用户可以一键替换。

### 8.2 `TimelineOp`
`add_clip`、`move_clip`（startMs、track）、`trim_clip`（inMs、durationMs）、`split_clip`（atMs）、`remove_clip`、`set_clip`（volume、fade、transition、still、text）、`add_track`、`set_track`（muted、volume）、`ripple_delete`（删除片段后，后面的片段前移补位）。全部是纯函数，放在 `canvas/src/timeline.ts`，界面和工具共用。

### 8.3 预览（浏览器，不录制）
- 剪辑台组件放在 `ui-sidebar-canvas/src/client/timeline/`：轨道区、时间尺（可缩放，最小单位 1 帧）、播放头、预览窗口。
- 预览窗口：每条视频轨对应一个 `<video>`，按当前时间切换 src 并 seek；图片片段用 `<img>` 加 CSS transform 模拟运镜；音频轨用 Web Audio 混音；文字轨用 DOM 叠加。预览和导出可能有细微差别，正式效果以导出为准，并在界面上注明。
- 交互：拖动片段、拖动边缘裁剪、`S` 在播放头处分割、`Delete` 删除、吸附到播放头和片段边缘（MV 还会吸附到节拍点）、音量用片段上的横线拖动调节。

### 8.4 导出（`timeline-render.ts`）
- `buildRenderPlan` 生成一条 ffmpeg `filter_complex`：
  1. 每个视频或图片片段：`trim`/`setpts`；统一缩放到目标尺寸，比例不一致时补边（`scale` + `pad`）；`fps`；图片用 `zoompan` 实现 `still` 运镜；
  2. 转场：`xfade`（dissolve 对应 `fade`，fade_black 对应 `fadeblack`）；
  3. 文字：`drawtext`，字体用现有的 `fontFile`；
  4. 音频：每个片段 `atrim`、`adelay`、`volume`、淡入淡出，最后 `amix`，`normalize=0`，再加 `alimiter`；
  5. 输出：H.264 `-crf` 按预设设置，`yuv420p`，AAC 192k，`+faststart`。
- 默认预设（`Config.exportPresets`）：`vertical_1080`（1080×1920，30fps，抖音/视频号）、`horizontal_1080`（1920×1080，30fps）、`square_1080`、`draft_540`（540 宽，快速检查用）。
- 导出过程：导出也注册成 `dsh-jobs` 任务（kind `render`），进度通过 ffmpeg `-progress pipe:1` 解析后上报给 job，timeline 节点的 `status` 是它的镜像；取消走 `job_kill` 或 Remote `media.cancel`。
- 导出结果：在 timeline 节点右侧建一个视频节点，从 timeline 节点和所有用到的素材节点各连一条派生边；同时在 `TimelineRef.exports` 里追加一条导出记录（路径、预设、时长、大小、时间）。
- 只导出音频：时间线里只有音频轨时，导出为 m4a。
- 微信回传：沿用 `packages/experimental/wechat` 现有判定，只对**由微信消息发起的那一轮**里的指定工具结果自动发回（现在的名单是 `generate_image`、`generate_video`、`generate_music`、`generate_speech`）。P4 把 `timeline_export` 加进名单；文件超过 20 MB 时改发 `draft_540` 导出。`canvas_generate` 是异步的，结果不在那一轮里，不自动发回，用户要时 Agent 调 `wechat_send_file`。

### 8.5 一键粗剪（`timeline-assemble.ts`）
- 短剧/漫剧：按场次顺序，再按段顺序，把视频节点排进视频轨 1（`still` 的镜头放对应的图片片段）；每句台词的音频放进音频轨 1，起点对齐所在镜头的起点，按台词顺序往后排；镜头比台词短时，把镜头时长延长到台词结束（视频片段停在最后一帧，图片片段直接延长）。音乐节点放进音频轨 2，音量 0.3，台词出现时自动压低到 0.15。
- MV：音乐放进音频轨 1，铺满；镜头按 `beat` 放置，没有 `beat` 的镜头按顺序卡到最近的节拍点上；视频原声默认静音。

---

## 9. 分期

每期一个 PR，从最新 master 拉分支，期与期之间按顺序合并。每期都要能独立使用，不能留半成品功能入口（未完成的界面入口不显示）。

| 期 | 名称 | 改动范围 | 依赖 |
|:--|:--|:--|:--|
| P1 | 数据模型与对话改图 | canvas：config、types、document（v1→v2 迁移）、operations（第 4.3 节）、storyboard、project、bible、layout、tools（`canvas_get`/`canvas_edit` 扩展，`studio_project_create`/`studio_episode_*`/`studio_bible_update`/`studio_expand_script`）；tool-media 落画布改为写版本；`studio-pipeline`、`studio-craft`、`studio-layout` 三个 skill；skill 注册改成枚举 `skillsRoot`（含 desktop、prepare.ts、升级指南） | 无（PR #6 已合并） |
| P2 | 按节点生成 | tool-media：node-runner、budget、voice、`canvas_generate`/`storyboard_voice`（任务走 `dsh-jobs`）；canvas：segments（移植）、production（闸门）、`studio_stage`；尾帧抽取和接力；Remote `media` | P1 |
| P3 | 画布界面 | ui-sidebar-canvas：顶栏、节点卡片、检查器、分镜表格编辑器、设定集和资产面板、版本条、状态层、连线 role 菜单、全屏、分集切换；canvas：journal（撤销、重做） | P2 |
| P4 | 剪辑台与出片 | canvas：timeline 纯函数；tool-media：timeline-render、timeline-assemble、beats、`timeline_*`、`audio_beats`；wechat：自动回传名单加 `timeline_export`；ui：剪辑台 | P3。**开工前先把剪辑台界面草图发给用户确认** |
| P5 | 品类 skill 与预设 | `drama-production`、`comic-production`、`mv-production`、`studio-director`（移植）；`media-studio` 预设；`media-editing` 去掉字幕字样；三个品类各录一条快照 | P4 |

---

## 10. 自测要求与验收条件

### 10.1 每期都要做
1. `pnpm install`，然后 `pnpm run build:artifacts`。
2. 定向单测和覆盖率：`pnpm exec vitest run --coverage <改动包的 tests 目录>`，改动的 `src/` 文件逐个 100%。提交前再跑一次 `pnpm run test:coverage`（CI 门禁）。
3. `pnpm run typecheck`、`pnpm run lint`，然后在最新的 `build:artifacts` 之后跑 `pnpm run build:check`。
4. 有文档改动时，跑 `pnpm run test:docs`。master 上本来就失败的几项（都在微信相关包）不用修，但要在 PR 里说明。
5. 录制回放快照：在 `snapshots/session/<case>/` 新增或更新用例，`pnpm run test:snapshot -t <case>` 通过。录制命令是 `pnpm run test:snapshot:record`，需要 key。
6. 真实 MAAS 端到端：先 `pnpm run build:artifacts`，再用构建产物里的 CLI 以 `headless` profile 运行，模型 `deepseek-v4-1-flash`，key 从 `AURORA_API_KEY` 读取，跑本期对应的那条对话（见下），保存会话日志和 `.canvas/` 目录作为证据。**不要把 key 写进日志或 PR。**
7. 有 GUI 改动时：用 `pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml` 启动，在真实浏览器里走一遍流程，截图并按 `dsh-client-ui-ux` 自审；PR 附真实流程 GIF（`record-browser-gif`）。
8. PR 描述按 `dsh-pr-description`；CI 全绿后才能交付。

### 10.2 P1 数据模型与对话改图
**单测必须覆盖：**
- `document.spec.ts`：v1 文件迁移成 v2，`path`/`prompt`/`model` 变成 v1 版本；`version: 3` 拒绝读取，原文件字节不变；损坏的 JSON 拒绝覆盖；超过上限时拒绝。
- `operations.spec.ts`：第 4.3 节每种操作的成功路径和每条校验规则的失败路径（每条一个用例）；role 推断表全覆盖；连成环时拒绝；`baseRevision` 不一致时整批拒绝；一次调用对一张分镜表只产生一个版本；`versionLimit` 超出时丢掉最旧的非 active 版本（含 active 恰好最旧的情况）；同一对节点不同 role 可并存、同 role 拒绝；`disconnect` 带和不带 role；不带 `baseRevision` 被 schema 拒绝。
- `storyboard.spec.ts`：`parseScenes` 能识别【场1】、`## 场1`、`第1场`，并能处理全角和半角数字；镜头校验（景别缺失、时长越界、角色不在设定集里）。
- `bible.spec.ts`：`expandMentions` 能处理别名、同一角色多次提及、不存在的 @名字（原样保留并给出警告）；删除仍被引用的条目时拒绝。
- `project.spec.ts`：没有 project.json 时行为与旧版一致；创建项目后 canvas.json 变成第 1 集，且文件不移动；会话绑定和切换；`canvas/change` 带正确的 `episode` 和 `files`；两集并发写互不覆盖。
- `config.spec.ts`：canvas Config 默认值和非法值在加载时报错。
- tool-media `skills.spec.ts`：枚举多个 skill 子目录；frontmatter 名和目录名不一致时报错；旧字段 `skillAssetRoot` 被拒绝。`prepare.ts` 的测试覆盖整个 `assets/` 被复制。
- `layout.spec.ts`：新类型的分列顺序；铺开 6 场后节点不重叠。

**真实 MAAS 对话（端到端）：**
> 「创建一个短剧项目《雨夜便利店》，竖屏。写设定集：两个角色、一个场景。写第一集剧本，3 场。把剧本铺开到场景，每场写一张分镜表。」

**验收条件（用脚本检查 `.canvas/`，结果附在 PR 里）：**
- [ ] `project.json` 的 `format` 为 `drama`，`spec.aspect` 为 `9:16`；
- [ ] `bible.json` 至少有 2 个 character、1 个 location 条目；
- [ ] 画布上有 1 个 script 节点、3 个场景组，每组有 1 个文本节点和 1 个 storyboard 节点，并有 `role=prompt` 的边；
- [ ] 每张分镜表至少 3 镜，每镜都有 `shotSize` 和 `durationSec`，`characters` 都是设定集里存在的 id；
- [ ] 再说一遍「把剧本铺开到场景」，节点数量不增加；
- [ ] 用旧版本生成的 v1 `canvas.json` 打开后，原有节点、边和媒体路径都在；
- [ ] 快照用例 `studio-p1-drama-setup` 通过。

### 10.3 P2 按节点生成
**单测必须覆盖：**
- `segments.spec.ts`：用 dsh-infinite_canvas `docs/storyboard-segmentation.md` 里的例子做输入，输出和原实现一致（在测试里写明原实现跑出的期望值）；每种 seg 类型、每种 join 都有用例；预算的调用次数 = 实际生成的段数（同一个函数）。
- `production.spec.ts`：G1 没有设定集时，拒绝生成参考图；G2 镜头缺少景别时，拒绝生成视频，并列出缺什么；G3 同一张表、同一组镜头 id，第二次不会新建视频节点，镜头组合变了时旧节点标 stale；越过闸门时有记录；阶段不能倒退，除非 override。
- `node-runner.spec.ts`（用假的生成函数、假的 ffmpeg 和测试用 jobs 注册表）：输入收集（第 4.5 节第 1–4 步各一个用例）、上一段未生成时返回 `tail_chain` 阻塞、`tailChain: false` 时跳过、分镜改写后按镜头集合复用节点和标 stale、参考图顺序、@展开后补上的参考图、超出上限时返回 needs_choice、模型选择（第 6 步）、尾帧建节点并连到下一段、手动首帧不被覆盖、并发上限、同节点重复提交、取消、失败保留旧版本、retryable 判定、重启后 running 改成 failed。
- `budget.spec.ts`：令牌稳定（同一份计划得到同一个令牌）；计划变化后令牌失效、执行前重算发现不一致时不调用生成函数；五种阈值各自的边界值（刚好等于、刚好小于）。
- `voice.spec.ts`：每句台词一个节点，按 `DialogueLine.id` 复用（换版本后也复用）；音色取设定；旁白取 `narrator`。

**真实 MAAS 对话：** 在 P1 的项目上接着说：
> 「给两个角色和场景生成参考图。然后生成场 1 的视频，并给场 1 配音。」

**验收条件：**
- [ ] 3 个参考图节点，`bible` 字段指向对应的设定条目，设定条目的 `imageNodes` 已回填；
- [ ] Agent 先给出预算（调用次数、秒数），用户回答「同意」后才开始生成视频；会话日志里能看到 `needs_confirmation` 和第二次带令牌的调用；
- [ ] 场 1 每段 1 个视频节点，入边里有 ref（角色和场景主图，order 正确）；第 2 段起有来自上一段尾帧节点的 `first_frame` 边；
- [ ] 每个视频节点的当前版本都有 `durationMs`、`width`、`height`；
- [ ] 场 1 每句台词 1 个音频节点，有 `gen.dialogue`；
- [ ] 让 Agent「重新生成场 1 第 1 段」，节点数不变，版本数 +1；
- [ ] 失败路径：用 profile overlay 把 tool-media 的 `baseURL` 指向本地假网关（对视频提交接口固定返回 500），重新生成一个节点，节点显示 failed 和原因、`retryable: true`，之前的版本还在；
- [ ] 快照用例 `studio-p2-generate`（用录制好的网关响应）通过。

### 10.4 P3 画布界面
**单测（client spec）必须覆盖：** 每种节点卡片的渲染（含状态层和版本条）；检查器控件按目录动态生成；参考图拖动排序后发出的 `reorder_refs`；连线 role 菜单；revision 冲突时保留表单输入；撤销/重做的纯函数；分镜表格编辑后发出的操作。

**真实界面流程（GIF）：**
1. 打开 P2 的项目，切到第 1 集，画布显示参考图、剧本、3 个场景组和场 1 的视频；
2. 选中场 2 分镜表，在表格里把第 2 镜改成近景、4 秒，右侧切段结果实时变化；
3. 选中场 2 第 1 段视频节点，在检查器里改为 9:16、5 秒，拖动参考图换顺序，把场 1 尾帧拖进首帧槽，点生成，弹出预算对话框，确认；
4. 生成中节点有进度，完成后出现新版本，切换版本；
5. 撤销最后一次参数修改；
6. 在对话里让 Agent「把场 2 第 1 段的参考图去掉道具」，画布实时更新，视口不跳动。

**验收条件：**
- [ ] 上面 6 步全部在真实应用里完成，GIF 附在 PR 里；
- [ ] 窗口宽 1280 时截两张图：右栏画布里检查器是抽屉，全屏工作室里检查器是侧栏；窗口宽 800 时全屏工作室里检查器是抽屉；
- [ ] 手动改动后，Agent 的 `canvas_get` 能读到（会话日志为证）；
- [ ] 中英两种语言下都没有硬编码文案（`verify-client-ui-i18n` 通过）；
- [ ] 打开 200 个节点的画布时，拖动画布没有明显卡顿：用 Performance 面板录 5 秒，长任务（Performance 面板标红的、超过 50 ms 的主线程任务）不超过 3 个，记录在 PR 里。

### 10.5 P4 剪辑台与出片
**单测必须覆盖：**
- `timeline.spec.ts`：每种 TimelineOp，包括边界情况（分割点在片段边缘、裁剪超出素材时长、ripple 删除）；诊断（空隙、重叠、素材丢失）。
- `timeline-render.spec.ts`：对固定的时间线，断言生成的 ffmpeg 参数（快照式比对）；覆盖比例不同的素材、图片运镜、每种转场、文字、静音轨、音量、只有音频。
- `timeline-assemble.spec.ts`：短剧（台词长于镜头时延长）、漫剧（still 片段）、MV（卡节拍点）；压低音乐。
- `beats.spec.ts`：用程序生成 120 BPM 的点击音轨（ffmpeg `sine` + `apad` 拼接），检测出的 BPM 在 118–122 之间，节拍误差不超过 30 ms。
- 集成测试（需要本机 ffmpeg，CI 没有时跳过并注明）：渲染一个 3 片段的时间线，用 ffprobe 检查时长（误差 ≤ 1 帧）、分辨率、有音轨。

**真实流程：**
- 对话：「把第 1 集粗剪成片，配一段轻快的背景音乐，导出竖屏。」
- 界面（GIF）：打开成片节点进入剪辑台；分割一个片段；把台词往后挪 0.5 秒；调低音乐音量；加一段手动文字；导出 `vertical_1080`。

**验收条件：**
- [ ] 画布上出现成片视频节点，派生边连到 timeline 节点和所有用到的素材；
- [ ] ffprobe：1080×1920，30fps，H.264 + AAC，时长与时间线一致（误差 ≤ 1 帧）；
- [ ] 抽 3 帧（`timeline_snapshot`）与预览窗口在相同时间点的截图并排放在 PR 里，画面内容一致；
- [ ] 导出过程中可以取消，取消后没有残留的半个文件；
- [ ] 由微信消息发起、并在那一轮里完成的 `timeline_export`，成片能自动发回（超过 20 MB 时发 `draft_540` 版本）——用模拟微信服务验证即可。

### 10.6 P5 品类 skill 与预设
**验收条件：**
- [ ] 三个品类各跑一条完整的真实 MAAS 对话，从一句话创意到导出 MP4，中间只在预算确认时回答「同意」：
  - 短剧：「做一集 60 秒左右的都市悬疑短剧，竖屏。」
  - 漫剧：「把这段小说做成 6 格竖屏漫剧，带配音。」（附 300 字文本；至少 4 格用 still 运镜）
  - MV：「用这首歌做一个 30 秒的 MV。」（附一个音频文件；镜头切换点和节拍点的误差 ≤ 1 帧）
- [ ] 三条对话各录一条快照用例：`studio-drama-e2e`、`studio-comic-e2e`、`studio-mv-e2e`；
- [ ] 三个 MP4 附在 PR 里（或给出下载地址）；
- [ ] 移植的文件都有出处注释，`NOTICE` 已更新；
- [ ] `media-editing` skill 里不再出现「字幕」相关的功能描述。

---

## 11. 风险与待定项
| 项 | 说明 | 处理 |
|:--|:--|:--|
| 视频模型的组合限制 | fl2va 支持首尾帧，ref2va 支持参考图，两者能不能同时用、单次最长几秒、参考图最多几张，以网关目录为准 | 代码不写死，统一读目录；P2 开工时先查一次目录并记在 PR 里 |
| indextts-2.5 是否支持参考音频固定音色 | 未确认 | P2 开工时先测；不支持时，`voice.sampleNode` 字段先不在界面显示 |
| relayvsr（视频超分） | 接口未确认 | 不在本期范围 |
| ffmpeg GPL | 安装包附带 GPL 静态版本 | 正式发布前请法务确认 |
| 预览和导出不一致 | 浏览器预览只是近似效果 | 界面注明以导出为准；P4 验收要求截图对比 |
| 旧版本打开新格式 | v2 的 canvas.json 旧版本读不了 | 旧版本遇到不认识的版本会拒绝读取并且不覆盖（现有行为，P1 要测）；写升级指南 |
| 画布性能 | 一集几十到上百个媒体节点 | 缩略图懒加载；视频只在悬停时加载；P3 有性能验收 |
| 花费失控 | 批量生成视频 | 预算令牌由代码强制；`confirmVideoCalls` 可配置 |
| 文档位置 | 仓库约定未实现的设计放 `.agents/notes/proposed/`，但那里要求中英双语和固定格式 | 这份规格保留在 `docs/`，已作为单语开发文档登记在 `scripts/translation-pairing.manifest.json` 的 `excluded` 里；全部五期合并后删掉本文，把仍有价值的决定写进对应包的 README 或 Agent Note |

---

## 12. 评审决定（v3）

对照现有代码的评审结论，已改进正文，这里列出改了什么、在哪一节：

| # | 问题 | 决定 | 位置 |
|:--|:--|:--|:--|
| 1 | 同一对节点只能一条边，表达不了「既是参考图又是首帧」 | 参考边 id 带 role，同对节点同 role 唯一；`disconnect` 可带 role；迁移时补 role | 3.1、3.2、4.3、7.5 |
| 2 | 分集没贯穿存储、Remote、事件 | `canvasFile(directory, episode?)`；按项目目录加锁；Remote 新增可选 `episode` 参数；`canvas/change` 带 episode、revision、files | 3.6、4.2 |
| 3 | Skill 注册只认一个目录 | `skillAssetRoot` 改名 `skillsRoot`（父目录），枚举子目录；改 desktop 和 prepare.ts；写升级指南 | 6.1、4.4 |
| 4 | canvas 包没有 Config | 新增 `config.ts` 和 schemastery 依赖 | 4.2 |
| 5 | `needs_choice` 形状另起一套 | 沿用 `ParamChoice` | 4.5、5.3 |
| 6 | 节拍放不进 `params` | 放到版本顶层 `beats` | 3.3、5.3 |
| 7 | `TimelineRef`、`ExportRecord`、`GateId` 未定义 | 补定义，节点加 `timeline` 字段 | 3.3、3.7 |
| 8 | 文档里的 TS 块会被 doc-typecheck 编译 | 标成 `ts ignore-check`，以 `types.ts` 为准 | 3 |
| 9 | 右栏最宽 600 px，侧栏检查器不可达 | 右栏里检查器总是抽屉；正式制作进全屏工作室 | 7.1、10.4 |
| 10 | 分镜改写后视频节点怎么算 | 按镜头 id 集合匹配复用，不匹配的标 stale | 3.3、3.4 |
| 11 | 自建队列还是 `dsh-jobs` | 用 `dsh-jobs`，删掉 `canvas_wait` | 4.1、4.6、5.3 |
| 12 | 确认期间画布变了 | 执行前重算计划和令牌，不一致不花钱、重新出预算 | 4.4、5.3 |
| 13 | 两个会话写同一集 | `baseRevision` 必填 | 2.1、5.2 |
| 14 | 语音、图片、音乐没有预算确认 | 一份计划，五种阈值任一触发都要确认 | 5.3 |
| 15 | 下一段还不存在时的尾帧接力 | 尾帧节点先建，生成下一段时再连；上一段没生成就阻塞；可用 `tailChain: false` 跳过 | 4.5 |
| 16 | 旁白和台词下标 | 台词带 id，speaker 可为 narrator，设定集加 `narrator` 音色 | 3.3、3.4、3.5 |
| 17 | 微信回传怎么判定 | 沿用微信插件按工具名单回传，P4 加 `timeline_export` | 8.4 |
| 18 | `versionLimit` 与 active | 丢最旧的非 active 版本 | 3.3 |
| 19 | 第二轮评审 | Remote 签名、G3 措辞、`stale` 与 `inputChanged` 分开、微信旧句、`ctx.jobs` 与模型工具分开、`JobKind` 登记、`JobId`、Config 总表、项目级文件的 revision、对账时机、导出注册 job、`canvas_get` 带分集 | 3.3、3.4、3.6、4.1、4.7、5.1、5.2、8.4 |
| 20 | 其他一致性问题 | `canvas_get` 的 `full`、工具归属表、`timeline.ts`、懒加载定死、取消可重试、预设位置、可复现的失败验收、长任务阈值、删掉排障记录 | 4.1、4.2、4.6、5.1、6.2、10 |
