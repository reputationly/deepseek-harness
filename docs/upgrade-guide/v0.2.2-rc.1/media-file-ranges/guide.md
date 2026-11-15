---
kind: upgrade-guide
description: "GET /api/file now honors single byte ranges instead of always returning the complete file."
---
# File byte ranges

English | [中文](guide.zh.md)

## Change

`GET /api/file` previously ignored Range. It now returns 206 with Content-Range for one supported byte range, or a bodyless 416 for an unsatisfiable range. Requests without Range, unsupported range syntax, and If-Range requests still receive the complete 200 response. HEAD remains metadata-only. Version redirects, authentication, filesystem policy, and file byte limits still apply.

## Migration

1. Clients requiring the complete file must omit Range.
2. Clients requesting ranges must handle 206 using Content-Range and handle 416 without treating it as file bytes.
3. Verify a request for `bytes=0-3` on a versioned file of at least four bytes returns 206, a four-byte body, and the matching Content-Range.

See the [file route reference](../../../../packages/api/session-controller/README.md#session-media-references).
