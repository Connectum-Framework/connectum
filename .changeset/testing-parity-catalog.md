---
"@connectum/testing": minor
---

feat: `transportParityTest` (`@connectum/testing/parity`) accepts `catalog` and `remoteResolver`, which both servers of a run receive as `createServer({ catalog, remoteResolver })` would. A scenario can now compare handlers that call other services with `ctx.call` and `ctx.stream` over HTTP/2 and over the in-process transport, on the `serviceCatalog` that `protoc-gen-connectum-catalog` generates. Tests that do not pass the options build the same servers as before.
