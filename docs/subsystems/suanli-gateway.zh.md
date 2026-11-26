# 蒜狸网关面

[English](suanli-gateway.md) | 中文

本产品的所有模型调用都经过同一个网关，因此由两个 Host 命名空间把网关自身的契约转换成客户端和设置页渲染的内容：[`@deepseek-ai/dsh-suanli-model-catalog`](../../packages/llm/suanli-model-catalog) 采用网关的 Hilo 模型目录，[`@deepseek-ai/dsh-suanli-media-tasks`](../../packages/llm/suanli-media-tasks) 在图像和视频传输上驱动生成任务。两者都在 Host 上持有网关 key；都不会把 key、任务 id 或产物 URL 放进模型请求。

## 目录采纳了什么

刷新不带 key 读取 Hilo 目录 `GET <catalogPath>`（默认 `/api/v1/models/catalog`），把其中 `text` 段与部署已知的条目合并——保留下来的条目沿用 `contextWindow`，`inputModalities` 按目录的 `supportsImage`、`supportsVideo` 和 `supportsAudio` 生成——再把结果写入路由的 volatile `models` 字段，选择器因此无需重启即可跟随平台。失败、无法解析或为空的读取从不清空目录：路由继续提供已有内容，`refresh()` 报告 `unreachable` 或 `empty-listing`。目录不按 key 裁剪；key 无权使用的模型在调用时失败。

## 媒体目录保留了什么

同一次读取还提供生成条目：每个 `image`、`video`、`audio` 条目成为一个条目，其 `interfaceType` 决定操作——`maas-music` 是音乐，`maas-speech` 是语音，空值或未知值采用所在段的默认操作。`media()` 返回最近一次成功读取的目录——状态、版本、读取时间，以及每个条目的传输方式、参数表、上限和玩法——媒体工作台据此渲染图像和视频。读取发生在启动时（不拖慢 Host）、本服务凭据引用的 `credentials/reference-updated` 之后，以及 `refresh()` 时；并发读取共用一次请求。状态为 `ready`；成功读取但没有图像或视频条目时为 `empty`；另有 `signed-out`（目录照常显示）、`rate-limited`、`unreachable`，首次读取完成前为 `loading`；失败、为空或无法解析的读取保留之前的条目、版本和读取时间。最近一次成功读取的目录在 `version` 变化时写入 `suanli_media_catalog` 存储域，并在首次请求前读回；没有该存储域时只保留在内存中。状态或版本的变化提交后发出 `suanli-model-catalog/media-updated`。

`capabilities()` 把最近一次成功读取的目录归入本产品的分类：对话、多模态识别、图像生成与编辑、视频生成、首尾帧、参考生视频、音乐和语音；词表之外的组合落入 `other`，而不是消失。`roles()` 给出六类角色——对话、多模态识别、生图、生视频、生音乐和生语音——各自使用的模型，取自用户保存在 `suanli_model_roles` 存储域中的选择或目录的默认值；`preferences()` 保存是否审核生成的图片和视频。`endpoint()` 回答必须调用同一网关的消费方，因此不需要第二行配置去指定消费方已经通过本服务到达的网关。

## 任务传输驱动了什么

网关用 OpenAI 兼容的任务端点提供生成：图像在 `/v1/images/generations`，视频与音乐在 `/v1/videos`。提交要么直接返回产物——图像端点会阻塞到图真的生成完——要么返回任务 id 供轮询；`status` 与 `wait` 把网关的词归一化成 `running`、`succeeded`、`failed`，读取 `progress` 与产物地址，而到截止时间的等待上报 `timed-out` 并让任务继续跑。只有显式 `cancel` 才让网关停下任务，且任务越过可停止的时点后网关可能用 `409` 拒绝。`download` 拉取任务上报的产物，`saveArtifact` 对调用方已持有的地址做同样的事，同步出图就是这样落盘的。

## 「创作」工作台

以插件形式内置的「创作」工作台经由本服务到达网关，而不是自己带一份配置：它读 `media()` 拿到要渲染的模型与玩法，用 `endpoint()` 取网关根与凭据名，并在每次提交时通过宿主凭据服务重新解析该凭据。因此它没有自己的网关字段、密钥与渠道表，部署换了网关或换了账号，工作台随之改变。

## 权威与边界

网关拥有「有哪些模型、每个模型提供哪些玩法、一个任务要跑多久」；本产品拥有合并、类别词表与预算。这里不决定模型的价格、可用性或产出质量，而网关没有声明的类不会出现，界面因此不会承诺平台给不出的能力。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsuanlimedia--suanlimediatasksservice"></a>

### `ctx.suanliMedia` — `SuanliMediaTasksService`

Host service backing the generated `ctx.remote.suanliMedia` namespace.

```ts cordis-catalog
/**
 * Submit one generation.
 * @param request - operation, model, prompt, and parameters.
 * @returns the task handle, or why no task exists.
 */
@Remote async submit(request: MediaSubmitRequest): Promise<MediaSubmitResult>

/**
 * Read one task's state.
 * @param taskId - gateway task id.
 * @param operation - operation that submitted it; the transport follows from it.
 * @returns the observation, or why it could not be read.
 */
@Remote async status(taskId: string, operation: MediaOperation): Promise<MediaStatusResult>

/**
 * Poll one task until it finishes.
 * @param taskId - gateway task id.
 * @param operation - operation that submitted it.
 * @param timeoutMs - how long the caller will wait.
 * @returns the terminal observation, or why the wait ended early.
 */
@Remote async wait(taskId: string, operation: MediaOperation, timeoutMs: number): Promise<MediaStatusResult>

/**
 * Ask the gateway to cancel one task.
 * @param taskId - gateway task id.
 * @param operation - operation that submitted it.
 * @returns whether the gateway accepted the request.
 */
@Remote async cancel(taskId: string, operation: MediaOperation): Promise<MediaCancelResult>

/**
 * Save an artifact URL a caller already received; image generation answers synchronously.
 * @param url - artifact URL the gateway reported.
 * @param targetPath - absolute path inside the caller's workspace.
 * @returns the written path and size, or why nothing was written.
 */
@Remote async saveArtifact(url: string, targetPath: string): Promise<MediaDownloadResult>

/**
 * Download a finished artifact to a path the caller owns.
 * @param taskId - gateway task id.
 * @param operation - operation that submitted it.
 * @param targetPath - absolute path inside the caller's workspace.
 * @returns the written path and size, or why nothing was written.
 */
@Remote async download(taskId: string, operation: MediaOperation, targetPath: string): Promise<MediaDownloadResult>
```

Source: [`packages/llm/suanli-media-tasks/src/index.ts`](../../packages/llm/suanli-media-tasks/src/index.ts)

<a id="ctxsuanlimodels--suanlimodelcatalogservice"></a>

### `ctx.suanliModels` — `SuanliModelCatalogService`

Host service backing the generated `ctx.remote.suanliModels` namespace.

```ts cordis-catalog
/**
 * Refresh the catalog from the gateway and put it in effect.
 * @returns how the catalog changed, or why it stayed as it was.
 */
@Remote async refresh(): Promise<CatalogSyncResult>

/**
 * Read the entries the route offers now, without contacting the gateway.
 * @returns the catalog in effect.
 */
@Remote read(): readonly CatalogEntry[]

/**
 * Read the capability classes the gateway declared at the last successful read.
 * @returns one member list per class, empty before a read succeeds.
 */
@Remote capabilities(): readonly ClassMembers[]

/**
 * Read the media catalog and why it is in the state it reports.
 * @returns the status, version, fetch time, and every entry of the last successful read.
 */
@Remote media(): MediaCatalogSnapshot

/**
 * Read the gateway a consumer must call to reach the catalog's capabilities.
 * @returns the gateway root and the credential reference holding its key.
 */
@Remote endpoint(): MediaGatewayEndpoint

/**
 * Read the models each role can use and which one it uses now.
 * @returns one state per role: chat, vision, image, video, music, speech.
 */
@Remote roles(): readonly ModelRoleState[]

/**
 * Choose the model one role uses.
 * @param role - a role other than chat, whose choice the conversation's model picker owns.
 * @param model - a candidate of the role, or `null` to return to the catalog default.
 * @returns the roles after the change.
 * @throws When the role is chat or the model is not a candidate of the role.
 */
@Remote async selectRole(role: ModelRole, model: string | null): Promise<readonly ModelRoleState[]>

/**
 * Read the generation preferences.
 * @returns whether generated media is reviewed.
 */
@Remote preferences(): MediaPreferences

/**
 * Turn the review of generated images and videos on or off.
 * @param enabled - whether to review.
 * @returns the preferences after the change.
 */
@Remote async setAutoReview(enabled: boolean): Promise<MediaPreferences>
```

Source: [`packages/llm/suanli-model-catalog/src/index.ts`](../../packages/llm/suanli-model-catalog/src/index.ts)

<a id="suanli-model-catalog-events"></a>

### `suanli-model-catalog/*` events

<a id="suanli-model-catalogmedia-updated--emit"></a>

#### `suanli-model-catalog/media-updated` — emit

The media catalog committed a change to its status or version.

```ts cordis-catalog
/**
 * The media catalog committed a change to its status or version.
 * @mode emit
 */
'suanli-model-catalog/media-updated'(): void
```

Source: [`packages/llm/suanli-model-catalog/src/types.ts`](../../packages/llm/suanli-model-catalog/src/types.ts)

<a id="suanli-model-catalogroles-updated--emit"></a>

#### `suanli-model-catalog/roles-updated` — emit

The role choices or generation preferences changed.

```ts cordis-catalog
/**
 * The role choices or generation preferences changed.
 * @mode emit
 */
'suanli-model-catalog/roles-updated'(): void
```

Source: [`packages/llm/suanli-model-catalog/src/types.ts`](../../packages/llm/suanli-model-catalog/src/types.ts)
<!-- END GENERATED cordis-surface -->
