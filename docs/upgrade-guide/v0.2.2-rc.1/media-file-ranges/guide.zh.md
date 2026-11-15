---
kind: upgrade-guide
description: "GET /api/file 现在响应单个字节范围，而不是始终返回完整文件。"
---
# 文件字节范围

[English](guide.md) | 中文

## 变更

`GET /api/file` 以前忽略 Range。现在对单个受支持的字节范围返回带 Content-Range 的 206，对不可满足的范围返回无响应体的 416。未携带 Range、不支持的范围语法，以及 If-Range 请求仍返回完整的 200 响应。HEAD 仍只返回元数据。版本跳转、鉴权、文件系统策略和文件字节上限继续生效。

## 迁移

1. 需要完整文件的客户端应省略 Range。
2. 请求范围的客户端应根据 Content-Range 处理 206，并处理 416，不将其视为文件字节。
3. 对至少四字节的版本化文件请求 `bytes=0-3`，确认返回 206、四字节响应体及匹配的 Content-Range。

详见[文件路由参考](../../../../packages/api/session-controller/README.zh.md#session-media-references)。
