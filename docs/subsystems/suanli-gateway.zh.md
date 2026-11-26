# 蒜狸网关面

[English](suanli-gateway.md) | 中文

本产品的每一次模型调用都经过同一个网关，因此有两个 Host 命名空间把网关自己的契约翻译成客户端与设置页要渲染的东西：[`@deepseek-ai/dsh-suanli-model-catalog`](../../packages/llm/suanli-model-catalog) 采用网关的模型列表与能力目录，[`@deepseek-ai/dsh-suanli-media-tasks`](../../packages/llm/suanli-media-tasks) 在图像与视频传输上驱动生成任务。两者都把网关 key 留在 Host；任何 key、任务 id 与产物地址都不经过模型请求。

## 目录采纳了什么

一次刷新读取 `GET <modelsPath>`（默认 `/v1/models`），只留要求的端点类型（默认 `openai`，即对话端点），与本部署已知的条目合并——留下来的条目保留它们已有的 `contextWindow` 与 `inputModalities`，因为网关列表不带这些字段——再把结果写进路由的 volatile `models` 字段，选择器因此无须重启即可跟随平台。失败的、未授权的或空的列表永远不清空目录：路由继续提供原有内容，`refresh()` 上报 `no-credential`、`unauthorized`、`unreachable` 或 `empty-listing`。

## 媒体目录保留了什么

`GET <capabilitiesPath>`（默认 `/v1/ov/capabilities`）与列表独立读取，任意一方失败都不改变另一方上报的内容。`media()` 返回最近一份成功目录——状态、版本、读取时间，以及每条的传输方式、任务类型、参数表、上限、交付时长与玩法——媒体工作台据此渲染图像与视频，其余操作由各自的使用方读取。读取发生在启动时（不阻塞 Host）、本服务凭据的 `credentials/reference-updated` 之后，以及 `refresh()` 被调用时；并发读取共用一个请求。状态为 `ready`；成功读取但没有图像或视频条目时为 `empty`；其余为 `signed-out`、`unauthorized`、响应体带 `kyc_required` 的 `403` 对应 `kyc-required`、`rate-limited`、`unreachable`；首次读取完成前为 `loading`。失败、空或无法解析的读取保留上一份目录的条目、版本与读取时间。最近一份成功目录存放在 `suanli_media_catalog` 存储域中，并在首次请求之前读回；没有该存储域时只存在于内存中。状态或版本的提交会发出 `suanli-model-catalog/media-updated`。

`capabilities()` 把最近一份成功目录的条目归入本产品的能力类：对话、文生图与图生图、文生视频、首尾帧、参考生视频、音乐与语音。一个声明了多种玩法的条目属于它命名的每一个类，所以一个同时带 `t2i` 与 `i2i` 的图像条目会填满两个图像类；词表之外的组合归入 `other` 而不是消失。`endpoint()` 回答必须自行调用同一网关的使用方，因此不再有第二行配置去配置一个已经通过本服务到达的网关。

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
<!-- END GENERATED cordis-surface -->
