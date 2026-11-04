---
"@connectum/core": patch
---

fix: a `remoteResolver` that returns something other than a `Transport` or `null` (a string, `undefined`, a `Promise` from an `async` resolver, an object without `unary` and `stream`) now fails the call with `Internal` and a message that names the service and says what was returned, instead of `transport.unary is not a function`. The value is no longer kept in the transport cache, so the resolver is asked again on the next call. The rejection of an abandoned `Promise` no longer surfaces as an unhandled rejection. This applies to `ctx.call`, `ctx.stream`, `server.client()` and `createCatalogClient()`. A resolver that returns `null` still gives `Unavailable`.
