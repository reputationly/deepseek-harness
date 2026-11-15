---
description: "项目画布文档、分集、项目与设定集文件，以及 canvas_get、canvas_edit 与 studio_* 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-canvas

[English](README.md) | 中文

<a id="summary"></a>

## 概述

管理同一个项目目录下的画布文档，让模型、媒体工具和 Web 客户端在同一份数据上工作。一个项目里每一集有一个画布文件，另有 `project.json`（题材、分集、会话绑定）与 `bible.json`（共用风格、角色、场景、道具）。节点保留候选版本和可选的已采用版本，边记录它为下游提供的输入用途，每次成功的编辑都会推进文档版本号，写入前必须带上调用方读到的那个版本号。

## 目录

- [使用本包](#use-this-package)
- [实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

```yaml
- id: canvas
  name: '@deepseek-ai/dsh-canvas'
  config:
    versionLimit: 8
```

基础 bundle 里这一行默认关闭；部署时与 `tool-media` 和客户端 `ui-sidebar-canvas` 行一起启用。

| 配置字段 | 默认值 | 含义 |
|:--|:--|:--|
| `maxNodes` | 10000 | 一张画布最多容纳的节点数。 |
| `maxEdges` | 20000 | 一张画布最多容纳的边数。 |
| `maxPromptLength` | 20000 | 单个节点允许的最长提示词字符数。 |
| `maxBatchOperations` | 64 | 一次 `canvas_edit` 调用最多携带的操作数。 |
| `versionLimit` | 8 | 保留的近期媒体版本数；已采用版本、输入快照和时间线历史固定引用的版本另外保留。 |
| `textVersionLimit` | 20 | 文本、剧本、分镜节点保留的版本数。 |
| `maxShotsPerStoryboard` | 24 | 一张分镜表最多的镜头数。 |
| `journalLimit` | 200 | 一集的撤销日志保留的编辑数。 |
| `timelineHistoryLimit` | 100 | 每个时间线节点在当前修订之外保留的历史修订数。 |

文件位于 `<项目>/.canvas/canvas.json`（没有 `project.json` 时是项目的单张画布，有则是指定它的那一集的画布）、`project.json`、`bible.json`，以及 `.canvas/episodes/` 下每一集一个文件。文件缺失即视为默认值：没有节点、没有项目元数据、设定集为空。

其他 Host 插件通过 `ctx.canvas` 使用本包：`read(session, episode?)` 读文档，`edit(session, operations, { baseRevision, episode, origin })` 一次写入一批操作，`resolveImages` 与 `resolveMedia` 把已采用的节点解析成文件路径，`bibleOf`、`updateBible`、`createProject`、`createEpisode`、`useEpisode` 管理项目级文件。`activeVersionOf(node)` 只解析已采用版本；没有已采用版本时，`previewVersionOf(node)` 可以展示最新候选。

时间线文件位于 `<episode-canvas>.timelines/<node>.json`。`timeline_get`、`timeline_edit`、`timeline_history` 与 `timeline_restore` 明确要求 `node`、`episode` 和项目 `directory`；写入要求 `baseRevision`。编辑器手势与历史恢复共用经过校验的时间线操作。恢复、撤销和重做都创建新修订，不覆盖历史。首次写入需要输出 `spec`，没有可撤销的持久化前身。

替换当前文件之前，旧修订先归档到 `<timeline-file>.history/`。提交失败保留此前承诺的历史窗口。历史元数据包含可用的撤销、重做目标；游标链接跨重启保留，没有链接的旧文件使用前一条已保存修订。当前时间线和保留的历史修订固定引用素材版本，阻止删除其源素材。删除素材前，需移除时间线引用并等待相关历史过期，或删除该时间线节点。

<a id="understand-the-implementation"></a>
## 实现

[公共入口](src/index.ts)导出项目、制作方案、设定集、编辑上下文和时间线契约。节点与版本 ID 为不透明标识；消费这些类型时，必须保留上述作用域与修订号检查。

`CanvasService` 解析会话的目标：目录、项目元数据，以及会话绑定的分集（`project.json` 的绑定，否则第一集）。`CanvasStore` 用一把锁串行化同一项目目录的每次写入，所以同时改画布和项目级文件在一次操作里落地；每次改写都先写临时文件再改名替换。解析或校验失败的文件不会被覆盖：读写抛 `CanvasCorruptError`，格式更新时抛 `CanvasUnsupportedVersionError`，Remote 命名空间分别报 `canvas/corrupt` 与 `canvas/unsupported-version` 并带上文件路径。

画布格式 1 和 2 在读取时迁移，将此前展示的版本明确记为选定版本；下一次写入持久化为格式 3。媒体的 `append_version` 添加候选而不自动采用。`set_version` 采用指定版本，传入 `null` 则清除采用。采用操作确认该节点的输入变化提示，并将下游生成节点标记为需要审核；追加候选不会执行这两项操作。输入快照和保留的时间线修订会保护其引用版本，避免历史裁剪删掉它们。

`applyOperations` 按顺序应用 `add`、`update`、`remove`、`set_gen`、`set_text`、`set_shots`、`update_shot`、`insert_shot`、`remove_shot`、`move_shot`、`set_version`、`connect`、`disconnect`、`reorder_refs`、`group`、`ungroup`、`move`、`resize`，最后把 `revision` 推进一次。宿主侧生成写回用 `append_version`、`set_status`、`set_stale`、`set_tail`，模型可见的 `canvas_edit` schema 不暴露它们；只写了生成参数、还没有文件的 `add` 会创建待生成节点。`planShotSegments` 把分镜表切成生成段：段首必须落在切点（换场、新角色、特写）上，连续续帧镜头不跨段，需要承接上一段画面的段标 `needsTailChain`；预算单和执行用同一个函数，报价不会与实际调用不一致。`production.ts` 保存阶段顺序、推进规则和 `G1`/`G2` 闸门，`production.json` 记录每一集的阶段与豁免；场次组用 `sceneOrigin` 记录来源剧本与场号，`studio_expand_script` 据此去重。`ref` 可以在同一批里被后续操作引用。同一次调用里对一张分镜的多次改写只产生一个版本。引用不存在的节点或镜头、重复的边或 role、会成环的连接、或节点类型放不下的内容，会被跳过并给出原因，其余操作照常应用。

边的 id 按 role 区分：派生边是 `<source>-><target>`，参考边是 `<source>-><target>:<role>`，所以一张图可以同时是某个视频的参考图和首帧。参考顺序由 `order` 字段表示，`reorder_refs` 负责重写。

Host 负责新节点的布局：列按边的深度从左到右，新节点向下移动直到不与任何节点重叠，组框按成员收拢。用户拖过的节点标记为 `placed`，不再被自动布局移动。

`canvas` Remote 命名空间提供 `get` 与 `apply`；每次写入都会发出 `canvas/change`，带上项目目录、分集，以及这次写过的每个文件的新 revision。对话驱动画布的决策记录在[设计笔记](../../../.agents/notes/implemented/feature/2026-11-10-conversation-driven-canvas.zh.md)。

<a id="model-experience"></a>

时间线节点把独立文档保存在画布旁的 `<canvas-file>.timelines/<node>.json`。`timeline` 读取它，`editTimeline` 按 revision 原子提交整批操作；对应模型工具是 `timeline_get` 和 `timeline_edit`。首次编辑须提供输出尺寸和帧率。片段固定引用节点及具体版本，节点新增当前版本不会替换已采用的片段。被引用版本不参与历史裁剪；删除其来源节点前须先移除片段。编辑与合成语义见[时间线参考](../../../docs/subsystems/canvas.zh.md#timelines)。

## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`canvas_get`、`canvas_edit` 与 `studio_*` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-canvas)。`canvas_get` 接受可选的 `nodes`、`detail`（`summary` 或 `full`）与 `include`（`bible`、`project`）。`canvas_edit` 接受一个 `operations` 数组和必填的 `baseRevision`。`studio_project_create`、`studio_episode_create`、`studio_episode_use`、`studio_bible_update`、`studio_expand_script` 负责建项目、建分集、写设定集，以及把剧本铺开成场次。schema 里没有坐标和尺寸字段。

#### Token 影响

在工具可见的每次请求里支付固定的 schema 开销；定义不随画布变化。

#### KV 缓存影响

定义及其可见性不变时前缀稳定。

### 工具调用历史与结果

#### 模型看到什么

`canvas_get` 先返回一行头部，含版本号、分集，以及项目与设定集文件是否存在，然后每个节点一行、每个组一行（带成员 id）、每条边一行。`summary` 下长文本与提示词会截断，除非 `nodes` 指定了要完整读取的节点。`detail: full` 保留全文并附上每张分镜的镜头；`include` 附上项目或设定集 JSON。完整读取或按节点读取还包含 JSON 历史，记录保留版本的 id、制作参数和输入快照；只有 `v=` 表示已采用的选择。`canvas_edit` 返回新版本号、创建出的 id 及其 `ref` 名，以及每个未能应用的操作一行 `Skipped operation <index> (<op>): <reason>.`。`baseRevision` 过期时调用失败，报 `canvas: revision is <actual>, not the <expected> this edit was based on`。

#### Token 影响

`canvas_get` 的结果随节点与边的数量、完整读取的文本与保留版本历史、分镜的镜头数，以及附带的项目或设定集 JSON 增长。`canvas_edit` 的开销是它的操作列表，结果随创建与跳过的数量增长。

#### KV 缓存影响

只追加；调用与结果跟在可复用的请求前缀之后，不会让已有 KV 缓存条目失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 客户端里的编辑不是会话事件；模型在下一次 `canvas_get` 时才能看到。
- 组不能嵌套，一个节点最多属于一个组。
- 画布图形历史仍保留在客户端；时间线历史通过 `timelineHistoryLimit` 持久化。`production.json` 已有定义但尚未写入。
- 分镜切段与生成执行在 `tool-media` 里；本包只负责存镜头。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文——点击展开</summary>

无。

</details>
