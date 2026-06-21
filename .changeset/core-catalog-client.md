---
"@connectum/core": minor
---

Add `createCatalogClient({ catalog, resolver })` — a standalone, catalog-typed client usable OUTSIDE a `Server`. Out-of-process callers (a Temporal worker, a scheduler, a CLI) now get the same typed, resolver-routed `call` (unary) and `stream` (server/client/bidi) ergonomics as the in-handler `ctx.call`/`ctx.stream`, keyed off the generated `ConnectumCallMap`/`ConnectumStreamMap`, without constructing a `Server`.

It resolves every target through the supplied `RemoteResolver` (`singleTransportResolver`/`mapResolver`/`dnsResolver`/`perServiceEnvResolver`) and dispatches over the returned `Transport`, caching the transport per `(typeName, endpoint)`. Because there is no in-process/local path, a service the resolver cannot resolve fails with `Code.Unavailable`; the rest of the error model mirrors `ctx.call` (`Unimplemented` for an unknown service/method, `Internal` when the resolver throws). Unlike `ctx.call`, `CallOptions` are applied verbatim — there is no inbound request, so the signal/deadline are not cascaded or clamped, no inbound headers are propagated, and no `ContextValues` are forwarded.

Additive only: `ctx.call`/`ctx.stream`/`createServer` behavior and public types are unchanged.
