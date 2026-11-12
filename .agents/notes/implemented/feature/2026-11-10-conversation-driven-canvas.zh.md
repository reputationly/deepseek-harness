# Agent Note：对话驱动的画布

Status: implemented

[English](2026-11-10-conversation-driven-canvas.md) | 中文

## 问题

媒体工具把生成的文件写进输出目录并返回路径。用户在一次对话里反复迭代图片和视频时，没有地方能看出哪个结果来自哪些输入，不能把“这三张图”当作一个整体来指代，复用之前的结果还得重复写文件路径。产品形态是对话加画布：用户说话，agent 放置节点、连线、分组，并把节点或整个组送进下一次生成。

## 决策

一个项目目录拥有每一集一份画布，另有项目元数据与共用设定集。`dsh-canvas` 是它们唯一的写入方，模型通过画布工具与 studio 工具编辑它们，媒体工具从中读取入参并把结果放上去，右侧栏的一个 tab 负责渲染画布。

### 文档

没有 `project.json` 时，`<project>/.canvas/canvas.json` 就是第 1 集的画布；有 `project.json` 时，它给出每一集的文件（其余是 `episodes/<id>.json`），并记录每个 Session 编辑哪一集。`<project>` 是 Session 的原始目录（`session.header.cwd`），没有时退回当前工作目录。`bible.json` 保存共用的风格、角色、场景和道具。

```json
{
  "version": 2,
  "revision": 3,
  "nextId": 4,
  "nodes": [
    { "id": "n1", "type": "image", "title": "Cat", "x": 0, "y": 0, "width": 280, "height": 280, "group": "g3", "activeVersion": "v1",
      "versions": [{ "id": "v1", "path": "/abs/cat.png", "prompt": "a cat", "model": "qwen-image-pro", "createdAt": "…", "origin": "agent" }] },
    { "id": "n2", "type": "text", "title": "Brief", "x": 0, "y": 320, "width": 280, "height": 160,
      "versions": [{ "id": "v1", "text": "…", "createdAt": "…", "origin": "user" }] }
  ],
  "edges": [
    { "id": "n1->n4:ref", "source": "n1", "target": "n4", "kind": "reference", "role": "ref", "order": 0 },
    { "id": "g3->n4", "source": "g3", "target": "n4", "kind": "derivation" }
  ]
}
```

节点类型有 `image`、`video`、`audio`、`text`、`script`、`storyboard`、`timeline` 和 `group`。id 很短（内容节点 `n<k>`，组 `g<k>`），因为模型要在后续调用里复述它们；`nextId` 保证删除之后 id 仍不重复。内容放在 `versions` 里，版本上限约束它但从不丢弃当前版本；`storyboard` 版本带镜头，音频版本可能带检测出的 `beats` 网格。`gen` 说明媒体节点如何生成，包括它对应哪几个镜头或哪句台词。一个节点最多属于一个组，组不能嵌套。

边记录它提供什么：一次生成从 source 得到 target 时是 `derivation`；为下游提供输入时是带 `role`（`prompt`、`ref`、`first_frame`、`last_frame`、`audio`、`source`）的 `reference`。参考边按 role 区分，所以一张图可以同时是某个视频的参考图和首帧。

`revision` 每次成功编辑推进一次，每个写入方都要声明自己读到的版本号；过期时整批调用在写入之前失败，这正是同一集上两个会话不会互相覆盖的原因。`project.json`、`bible.json` 和画布各有自己的 revision，由存储在每次写入时推进。

写入按项目目录串行执行，先校验，再通过临时文件加 rename 替换每个文件。解析或校验失败的文档绝不会被覆盖：读取和编辑以 `canvas/corrupt` 失败，格式更新的文件以 `canvas/unsupported-version` 被拒绝，直到文件修好或删掉。版本 1 的画布在读取时迁移。文件不存在就是一张空画布。

### 模型工具

`canvas_get` 返回版本号、分集、`project.json` 与 `bible.json` 是否存在、节点、组及其成员、边；`nodes` 把范围缩小到指定 id，`detail: full` 保留长文本并附上分镜镜头，`include` 附上项目或设定集 JSON。`canvas_edit` 在一次写入里按顺序应用一组操作，并必填 `canvas_get` 返回的 `baseRevision`：

| `op` | 字段 | 效果 |
|---|---|---|
| `add` | `ref`、`type`、`title`、`path`/`text`/`shots`、`gen`、`bible`、`group` | 新建内容节点及其第一个版本；`ref` 是它在本次调用后续操作里的名字 |
| `update` | `node`、`title`、`text`、`path` | 修改一个节点的字段；改文本或路径会新增版本 |
| `remove` | `node` | 删除节点及其边；删除组时保留成员 |
| `set_gen` | `node`、`gen` | 改生成参数；值为 `null` 表示删除该参数 |
| `set_text` / `set_shots` | `node`、`text`/`shots` | 存一个新版本 |
| `update_shot` / `insert_shot` / `remove_shot` / `move_shot` | `node`、`shot`、patch 或 `after` | 改分镜里的一个镜头；一次调用最多产生一个版本 |
| `set_version` | `node`、`version` | 切换节点展示的版本 |
| `connect` / `disconnect` | `from`、`to`、可选 `role` | 添加或删除一条边；不带 `role` 时删除两节点之间的全部边 |
| `reorder_refs` | `node`、`sources` | 重写参考顺序 |
| `group` / `ungroup` | `ref`、`title`、`nodes` / `node` | 把节点圈成组，或解散组并保留成员 |

`studio_project_create`、`studio_episode_create`、`studio_episode_use`、`studio_bible_update`、`studio_expand_script` 负责建项目、建分集、写设定条目，以及把剧本每一场铺开成组；`studio_bible_update` 拒绝删除仍被分镜使用的条目。

模型从不给坐标。服务按边的深度把新节点从左到右排在它们所连节点的旁边，把新节点向下挪到不与任何节点重叠，绝不移动用户摆放过的节点，并按成员重算组的大小。指向未知节点、重复连边或会成环的操作会被跳过，并连同原因记在 `skipped` 里；其余操作照常生效，所以用户在回合中途删掉一个节点不会让整次调用失败。结果里返回 `ref` 到 id 的映射。

### 节点和组作为生成入参

`generate_image` 和 `generate_video` 接受 `referenceNodes`，`generate_video` 还接受 `firstFrameNode` 和 `lastFrameNode`。节点 id 解析为该图片节点的文件。组 id 解析为组内的图片成员，按阅读顺序排列（从上到下，再从左到右）。文件路径参数照常可用，并与节点入参合并。引用不存在、不是图片，或是一个没有图片的组时，调用在发出任何网关请求之前就失败。

生成成功后，工具添加一个节点，其第一个版本带写出的文件、prompt 与 model，`gen` 记录是什么生成的，从每个被引用的节点或组各连一条 `derivation` 边，并把节点 id 作为 `nodeId` 返回。`tool-media` 的画布写入同样声明读到的版本号，并遵循与模型工具相同的冲突规则。返回 `needs_choice` 的调用不改动任何东西。没有挂载 `dsh-canvas` 时，媒体工具的行为和以前一样，并拒绝节点参数。

### Remote API 与侧栏 tab

`CanvasService` 暴露 `canvas` Remote 命名空间：`get` 读取文档，`apply` 应用用户的编辑（模型的那些操作加上 `move` 和 `resize`），`canvas/change` Remote 事件通知 Client 重新读取。`dsh-client-ui-sidebar-canvas` 里的画布 tab 用 `@xyflow/react` 渲染文档：媒体和文本卡片、组框、边、缩略图、缩放控件、拖动移位、在 handle 之间拖线连接、删除。图片字节通过 `workspaceFiles.readBytes` 读取。用户移动过的节点会被标记为 `placed`，布局以此为准不再动它。

## 考虑过的替代方案

- **移植内部设计工具的画布渲染层。** 否决：它基于 React 19 和一份 fork 的 flow 库，还复刻了另一个产品的界面；这里的 Client 是 React 18，文案归 locale 所有，并有自己的视觉语言。它的文档形状、写入安全措施和“由宿主放置结果”的规则保留了下来。
- **白板库（Excalidraw、tldraw）。** 否决：自由图形表达不了“这个结果由那些输入派生”，tldraw 的许可还限制生产使用。`@xyflow/react` 是 MIT 许可，天生就是节点加边。
- **每种操作一个工具。** 否决：搭一个五节点的图要花十几个模型回合，失败时还会留下搭了一半的画布。带调用内 ref 的一组操作只要一个回合、一次写入。
- **让模型自己传组成员的文件路径。** 否决：它得先读画布、抄路径、保持顺序，派生边也丢了。在 Host 上解析 id，组才始终是用户所说的那个整体。
- **把画布存进 Session 日志。** 否决：画布属于项目，寿命比一次对话长；普通文件也方便用户备份或交给别的工具。

## 影响

- 模型按 id 复用之前的结果，画布记录每个结果的来源；代价是多了一种需要保持兼容的文档格式。
- 布局是确定的并由 Host 负责，所以重放同样的操作得到同样的画布；模型不能要求特定的排布。
- 同一项目上的 Session 共用一张画布；并发编辑串行执行，同一字段以最后一次写入为准。
- 用户在 tab 里的编辑不是 Session 事件，所以模型要到下一次 `canvas_get` 才知道。

## 测试

- 单元测试覆盖文档校验、版本 1 迁移、损坏与更新版本的拒绝、部署上限、每种操作及其跳过原因与版本冲突、布局（按深度分列、避免重叠、已摆放节点不动、组边界）、role 推断与按 role 区分的边、项目与设定集解析及其 revision 守卫、组的解析顺序，以及对着假网关的媒体工具：两张图的组以两张图的形式到达 `/images/edits`，结果节点带一条来自该组的 `derivation` 边和一个记录写出路径的版本。
- 真实网关的实测使用 headless profile，加一个对着产品网关启用 `tool-media` 的 patch，key 只通过环境变量提供。它对照 `canvas.json` 检查三段对话：一次请求里创建、连接并分组文本节点；两张生成的图片被放置并分组；以该组为入参生成一张图片，并有从组到结果的边。key 不出现在任何日志、fixture 或提交里。
- tab 在 Web Client 里对着那次实测写出的画布检查：节点、组框和边都能渲染，拖动过的节点在重新加载后保持位置，agent 的编辑无需重新打开 tab 就会出现。
