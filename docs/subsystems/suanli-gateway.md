# Suanli gateway surfaces

English | [中文](suanli-gateway.zh.md)

This product routes every model call through one gateway, so two Host namespaces translate the gateway's own contracts into what the client and the settings page render: [`@deepseek-ai/dsh-suanli-model-catalog`](../../packages/llm/suanli-model-catalog) adopts the gateway's model listing and capability catalog, and [`@deepseek-ai/dsh-suanli-media-tasks`](../../packages/llm/suanli-media-tasks) drives generation tasks on the image and video transports. Both hold the gateway key on the Host; neither puts a key, a task id, or an artifact URL through a model request.

## What the catalog adopts

A refresh reads `GET <modelsPath>` (default `/v1/models`), keeps the endpoint types asked for (default `openai`, the chat endpoint), merges the listing with the entries the deployment already knew — an entry that survives keeps its `contextWindow` and `inputModalities`, which a gateway listing omits — and writes the result into the route's volatile `models` field, so the picker follows the platform without a restart. A failed, unauthorized, or empty listing never clears the catalog: the route keeps serving what it had and `refresh()` reports `no-credential`, `unauthorized`, `unreachable`, or `empty-listing`.

## What the media catalog keeps

`GET <capabilitiesPath>` (default `/v1/ov/capabilities`) is read independently of the listing, so either may fail without changing what the other reports. `media()` returns the last good generation — status, version, fetch time, and every entry with its transport, task types, parameter schema, limits, delivery durations, and modes — and the media workbench renders images and video from it while its own consumer reads the other operations. A read happens at startup without delaying the Host, after `credentials/reference-updated` for this service's reference, and on `refresh()`; concurrent reads share one request. The status is `ready`, `empty` for a successful read without an image or video entry, `signed-out`, `unauthorized`, `kyc-required` for a `403` whose body carries `kyc_required`, `rate-limited`, `unreachable`, or `loading` until the first read settles; a failed, empty, or unreadable read keeps the previous entries, version, and fetch time. The last good generation is stored in the `suanli_media_catalog` storage domain and read back before the first request, and stays in memory where that domain is absent. `suanli-model-catalog/media-updated` follows a committed status or version change.

`capabilities()` groups the entries of the last good generation into this product's classes: chat, image generation and editing, video generation, first/last frame, reference-to-video, music, and speech. One entry that declares several plays belongs to every class it names, so a single image entry with `t2i` and `i2i` fills both image classes; a pair outside the vocabulary lands in `other` rather than disappearing. `endpoint()` answers a consumer that must call the same gateway, so no second row configures the gateway a consumer already reaches through this one.

## What the task transport drives

The gateway answers generation through OpenAI-compatible task endpoints: images under `/v1/images/generations`, video and music under `/v1/videos`. A submission answers either with a finished artifact — the image endpoint blocks until the image exists — or with a task id to poll; `status` and `wait` normalize the gateway's words to `running`, `succeeded`, or `failed`, read `progress` and the artifact URL, and a wait that reaches its deadline reports `timed-out` while leaving the task running. Only an explicit `cancel` asks the gateway to stop it, and the gateway may refuse with `409` once a task is past the point where it can stop. `download` fetches the artifact a task reported, and `saveArtifact` does the same for a URL a caller already holds, which is how a synchronous image answer reaches disk.

## The 创作 workbench

The 「创作」 workbench that ships as an installed plugin reaches the gateway through this service rather than through a configuration of its own: it reads `media()` for the models and modes it renders, calls `endpoint()` for the gateway root and the credential reference, and resolves that reference per submission through the host credential service. It therefore has no gateway field, no key, and no channel table of its own, and a deployment that changes its gateway or its account changes the workbench with it.

## Authority and limits

The gateway owns which models exist, which plays each one serves, and how long a task takes; this product owns the merge, the class vocabulary, and the budgets. Nothing here decides a model's price, availability, or output quality, and a class the gateway does not declare stays absent rather than promising a capability the platform cannot serve.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
