---
"@connectum/core": minor
---

fix: `outgoingInterceptors` now run on every catalog route

`createServer({ outgoingInterceptors })` was documented since 1.0.0 as the client-side chain for every `ctx.call` / `ctx.stream` and `server.client()` call, but it ran only on `ctx.call` / `ctx.stream` to services mounted on the same server. It now runs exactly once per call on every route — in-process, `remoteResolver` transports and `mockResolver` routes in `createMockContext` — and on `server.client()` for local and remote targets, for unary and all streaming kinds. The resolver's transport is wrapped (Connect's `runUnaryCall` / `runStreamingCall` around it): the chain runs outside the transport's own interceptors, the deadline budget starts before the first interceptor, and the transport receives the remaining budget. With an empty chain the resolver's transport is used unchanged. `server.localClient()` and `createLocalTransport()` stay plain. On a resolver route the chain observes `req.url` as `https://catalog/<typeName>/<Method>` and no protocol headers; wire-level policy (header signing, host-derived audiences) belongs on the resolver's transport.

New: `createCatalogClient({ outgoingInterceptors })` — an explicit chain for the standalone client (default empty; it never inherits one from a `Server`).

**Migration (BREAKING for one configuration):** if you mounted the same signer, OpenTelemetry or retry interceptor on the resolver's transports as a workaround for remote routes, remove that copy — it would now run twice (two client spans, two token-factory calls, retry amplification). Keep application policy in `outgoingInterceptors` and only transport-specific middleware (TLS, compression, per-upstream gateway headers) on the transports. A `server.client()` call to a local service now also runs the chain; use `server.localClient()` for the plain in-process client.
