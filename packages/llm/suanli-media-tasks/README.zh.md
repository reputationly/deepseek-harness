---
description: "Host Remote 命名空间：通过网关的 OpenAI 兼容任务接口提交、轮询、取消并下载本部署的生成任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-suanli-media-tasks

[English](README.md) | 中文

## 概述

Host Remote 命名空间：通过网关的 OpenAI 兼容任务接口提交、轮询、取消并下载本部署的生成任务，网关 key 始终留在 Host。

## 目录

- [为什么需要它](#why-this-exists)
- [传输规则](#transport-rules)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

## 为什么需要它 <a id="why-this-exists"></a>

平台能力目录里的生成类操作走不了聊天路由：图像在 `/v1/images/generations`，视频与音乐在 `/v1/videos`。本服务是唯一说这两套协议的地方，调用方只提交提示词、拿到任务 id，然后轮询到终态，不需要接触 key，也不用自己管轮询节奏。

## 传输规则 <a id="transport-rules"></a>

- 提交要么直接返回产物（图像端点可能同步返回），要么返回任务 id；两者都以同一个结果上报。
- 状态词归一化为 `running`、`succeeded`、`failed`；`SUCCESS`/`succeeded` 与 `FAILURE`/`failed` 是网关自己的词表。
- 等待在调用方给的截止时间以 `timed-out` 结束，任务继续跑；只有显式 `cancel` 才会让网关停下它。
- 调用方取消会停止等待，不产生网关调用。
- 任务已经越过可停止的时点后，网关会用 `409` 拒绝取消；这一情况按 `rejected` 附 HTTP 状态上报，不当作传输失败。
- `download` 读任务上报的产物地址，并严格写入调用方指定的路径；调用方手里已有地址时用 `saveArtifact`，同步出图就是这样落盘的。
- `speak` 用同一个 key 把文本和目录参数发到 `/v1/audio/speech`，把返回的音频写到调用方指定的路径。
- `inspect` 用同一个 key 通过 `/v1/chat/completions` 把一段指令和内联的图片或视频发给多模态识别模型，返回回答文本；文件大小由调用方限制。
- 图像调用有独立预算（默认 240 秒）：图像端点要等图真的生成完才回答，任务类端点先返回 id、再单独轮询。

## 模型体验 <a id="model-experience"></a>

不涉及：本服务只搬运调用方给的请求与产物，自身不进入提示词、工具 schema 或工具结果。

#### KV Cache 影响

无：这里不构造也不缓存任何模型请求。

## 已知限制与后续工作 <a id="known-limitations-and-deferred-work"></a>

- 产品内只有生图有调用方，即 `@deepseek-ai/dsh-suanli-media-tools` 的 `generate_image` 工具；视频与音乐任务目前只由本包测试与直接 Remote 调用覆盖。
- 图像调用很慢（本部署 2K 图约 36 秒），调用方要按阻塞调用预留时间，而不是显示一个没有截止时间的转圈。
- 图生图与参考生视频需要平台先声明对应能力条目；在那之前这些模型不在本部署读取的目录里。
- 产物写入调用方给的绝对路径；产品内调用方必须把该路径限制在 Session 工作区内。

<a id="dev-note"></a>
### 开发备注

两套传输在提交时的回答本来就不同：图像端点可能直接返回产物，任务端点返回 id。所以提交上报一个联合结果而不是假定一定有任务，只有 `taskId` 非空时调用方才轮询。轮询放在 Host 是因为凭据在这里：让浏览器自己轮询要么泄漏 key，要么得再造一层代理。
