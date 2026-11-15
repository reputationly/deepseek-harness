---
kind: upgrade-guide
description: 画布格式 3 将生成的媒体候选与已采用版本分开保存。
---

# 明确采用画布中的媒体版本

[English](guide.md) | 中文

## 变更

画布格式 3 将生成的图片、视频、音乐和语音保存为未采用候选。生成保留已采用版本；下游生成读取已采用的输入。预览不会采用版本。

格式 1 和 2 仍可读取，迁移时会将原先显示的版本明确记为选定版本。旧构建无法读取格式 3。剧本、设定集和分镜文档结构保持不变。

自定义客户端必须向 `media.videoPreview(session, node, version, scope)` 传入捕获的项目目录与分集，防止跨项目读取。“重试预览”会重新读取选定候选，不生成或采用版本。

调用 `media.editMedia(session, request)` 或 `media_edit` 时需提供准确的来源节点、版本与捕获的项目范围。本地 `media-edit` 任务产生候选，不创建付费生成检查点。失败时 `media/edit` 详情包含 `kind` 和已完成文件的 `path`。结果不明时需重新读取后再重试；相同请求复用候选或已完成文件。画布 Host 的 `edit(..., { atomic: true })` 会拒绝包含跳过操作的整批写入；`add.initialVersion` 原子附加完整候选元数据。

暂存上传 `media.importVideo`/`media.importAudio` 接收 `LocalMediaImportRequest`，回执必须属于接收方会话。经过校验的字节流式写入原项目的 `.canvas/imports/`，成为未采用版本，不使用整文件 RPC 或云端生成。“新建视频”发起视频上传；音乐和语音在生成前也提供“上传本机音频”。

画布上传、直接编辑、预览渲染和直接生成将 `JobSpec.completionNotice` 设置为 `'none'`，更新界面而不启动 Agent 轮次。模型发起的任务保留完成通知。请一起升级 `jobs`、`jobs-local`、`tool-jobs` 和媒体服务。

自定义客户端通过 `canvas.editorContext(session, context)` 上报提示，省略 context 则清除。捕获的项目范围、应用、节点与版本、时间线选区和未保存草稿标志在模型请求前进入已记录的运行上下文，不包含草稿值。提示不会保存修改或采用候选。升级画布时需一并声明 Agent/system-prompt 依赖。不调用此接口的客户端仍可使用，但不提供选择提示。

## 迁移

1. 升级前备份项目的 `.canvas/` 目录。同步升级 Host，并重新载入 Web 客户端或重启 Desktop。
2. 打开项目。首次成功编辑画布时写入格式 3；单纯打开文件不会重写它。确认原先选定的媒体仍显示为已采用。
3. 将节点用作生成参考前，先采用一个候选。可以使用编辑器的采用操作，或通过 `canvas_edit` 调用 `set_version`。旧视频尾帧若缺少准确来源版本记录，需重新提取后再承接下一段。时间线来源固定引用不透明的版本标识，包括导入与本地编辑候选。
4. 构造 `CanvasDocument` 的集成需要输出版本 3，或通过 `parseCanvas` 读取已有 JSON。缺少 `activeVersion` 表示没有已采用版本；解析生成输入时，不得回退到最新存储版本。
5. 如需返回旧构建，请恢复备份。不要修改格式 3 文件中的版本号。
