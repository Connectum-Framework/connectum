---
"@connectum/testing": minor
---

feat: `createMockContext` takes `method` and `signal`. `method: "pkg.v1.Service/Method"` (the key format of `ctx.call`) chooses the method the handler under test sees as `ctx.service`, `ctx.method` and `ctx.url`; before, the context always described the first method of the first service of the catalog, so a handler of the second service read another service's method. An unknown service or method, or a malformed value, throws a `TypeError` that names `options.method`. `signal` is the inbound request's abort signal: `ctx.signal` aborts when it does and the abort cascades into the outgoing calls of the handler. Without the new options nothing changes: the context still describes the first method of the first service, which is correct only for a catalog of a single method.
