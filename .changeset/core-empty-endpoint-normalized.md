---
"@connectum/core": patch
---

fix: an empty `endpoint` in `CallOptions` or `server.client()` options is now treated as no endpoint everywhere. The transport cache already gave `""` and an absent endpoint one entry, but the `remoteResolver` received `{ typeName, endpoint: "" }` or `{ typeName }` depending on which call came first, and every later call reused whatever transport that first call produced. The resolver now always receives `{ typeName }` for both, in `ctx.call`, `ctx.stream`, `server.client()` and `createCatalogClient()`, and the no-route message no longer prints an empty endpoint.
