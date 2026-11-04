---
"@connectum/core": patch
---

docs: the type documentation of `NodeResponse` now says which members a protocol `httpHandler` can call on the HTTP/1.1 or HTTP/2 response (`statusCode`, `setHeader`, `end`) and why `res.writeHead(200, headers)` and `res.write(chunk)` do not compile on the union (TS2349). The type is unchanged. The raw-HTTP examples in the protocol guide used `writeHead` and failed `tsc --strict`; they now set `statusCode` and the headers, and the same handler is covered by an integration test over HTTP/1.1 and HTTP/2 and by the release gate's consumer type-check.
