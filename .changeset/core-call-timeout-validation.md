---
"@connectum/core": minor
---

fix: `CallOptions.timeoutMs` on `ctx.call`, `ctx.stream` and `createCatalogClient()` must be a finite number greater than 0. A zero or negative value used to remove the deadline the call inherits, so the callee ran without any limit; it now rejects the call with `InvalidArgument` and a message that names `timeoutMs`, as do `NaN`, `Infinity` and non-numbers. When the inbound deadline has already passed, a nested `ctx.call` or `ctx.stream` fails with `DeadlineExceeded` instead of passing a non-positive timeout on. Valid values keep their meaning: the effective timeout is still `min(timeoutMs, remaining)`.
