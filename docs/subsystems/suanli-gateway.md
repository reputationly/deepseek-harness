# Suanli gateway surfaces

English | [中文](suanli-gateway.zh.md)

This product routes every model call through one gateway, so two Host namespaces translate the gateway's own contracts into what the client and the settings page render: [`@deepseek-ai/dsh-suanli-model-catalog`](../../packages/llm/suanli-model-catalog) adopts the gateway's model listing and capability catalog, and [`@deepseek-ai/dsh-suanli-media-tasks`](../../packages/llm/suanli-media-tasks) drives generation tasks on the image and video transports. Both hold the gateway key on the Host; neither puts a key, a task id, or an artifact URL through a model request.

## What the catalog adopts

A refresh reads `GET <modelsPath>` (default `/v1/models`), keeps the endpoint types asked for (default `openai`, the chat endpoint), merges the listing with the entries the deployment already knew — an entry that survives keeps its `contextWindow` and `inputModalities`, which a gateway listing omits — and writes the result into the route's volatile `models` field, so the picker follows the platform without a restart. A failed, unauthorized, or empty listing never clears the catalog: the route keeps serving what it had and `refresh()` reports `no-credential`, `unauthorized`, `unreachable`, or `empty-listing`. The same refresh reads `GET <capabilitiesPath>` (default `/v1/ov/capabilities`) and groups what the gateway declares into this product's classes: chat, image generation and editing, video generation, first/last frame, reference-to-video, music, and speech. One entry that declares several plays belongs to every class it names, so a single image entry with `t2i` and `i2i` fills both image classes; a pair outside the vocabulary lands in `other` rather than disappearing.

## What the task transport drives

The gateway answers generation through OpenAI-compatible task endpoints: images under `/v1/images/generations`, video and music under `/v1/videos`. A submission answers either with a finished artifact — the image endpoint blocks until the image exists — or with a task id to poll; `status` and `wait` normalize the gateway's words to `running`, `succeeded`, or `failed`, read `progress` and the artifact URL, and a wait that reaches its deadline reports `timed-out` while leaving the task running. Only an explicit `cancel` asks the gateway to stop it, and the gateway may refuse with `409` once a task is past the point where it can stop. `download` fetches the artifact a task reported, and `saveArtifact` does the same for a URL a caller already holds, which is how a synchronous image answer reaches disk.

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
@Remote refresh(): Promise<CatalogSyncResult>

/**
 * Read the entries the route offers now, without contacting the gateway.
 * @returns the catalog in effect.
 */
@Remote read(): readonly CatalogEntry[]

/**
 * Read the capability classes the gateway declared at the last refresh.
 * @returns one member list per class, empty before a refresh reads the catalog.
 */
@Remote capabilities(): readonly ClassMembers[]
```

Source: [`packages/llm/suanli-model-catalog/src/index.ts`](../../packages/llm/suanli-model-catalog/src/index.ts)
<!-- END GENERATED cordis-surface -->
